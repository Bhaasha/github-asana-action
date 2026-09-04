// A tiny in-process stand-in for the parts of the Asana API this action calls,
// so the test suite runs with no credentials. Point the sdk at it with
// `Asana.ApiClient.instance.basePath = stub.url`.
//
// It is deliberately stateful: tasks remember their section per project and
// their custom field values, so the same assertions hold whether the suite runs
// against this or against real Asana.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Named = { gid: string; name: string };
type EnumOption = Named;
type CustomField = Named & {
  resource_subtype: "number" | "enum";
  enum_options?: EnumOption[];
};

// gids have to be digit strings: the action only recognises asana urls whose
// project and task segments match \d+
const ORGANIZATION_GID = "1100000000000001";
const PROJECT: Named = { gid: "1200000000000001", name: "Asana bot test environment" };
const SECTIONS: Named[] = [
  { gid: "1300000000000001", name: "New" },
  { gid: "1300000000000002", name: "Done" },
];
const CUSTOM_FIELDS: CustomField[] = [
  {
    gid: "1400000000000001",
    name: "Custom Number",
    resource_subtype: "number",
  },
  {
    gid: "1400000000000002",
    name: "Custom Enum",
    resource_subtype: "enum",
    enum_options: [
      { gid: "1500000000000001", name: "OK" },
      { gid: "1500000000000002", name: "Not OK" },
    ],
  },
];

type StubTask = {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  projects: Named[];
  /** project gid -> section gid */
  sections: Map<string, string>;
  /** custom field gid -> raw value as sent by the client */
  customFields: Map<string, unknown>;
};

type StubStory = {
  gid: string;
  taskGid: string;
  text: string;
  is_pinned: boolean;
};

export type AsanaStub = {
  url: string;
  organizationId: string;
  projectId: string;
  sectionNames: string[];
  close: () => Promise<void>;
};

function compactProject(project: Named) {
  return { gid: project.gid, resource_type: "project", name: project.name };
}

function compactSection(section: Named) {
  return { gid: section.gid, resource_type: "section", name: section.name };
}

function customFieldValue(field: CustomField, value: unknown) {
  const base = {
    gid: field.gid,
    resource_type: "custom_field",
    name: field.name,
    resource_subtype: field.resource_subtype,
  };
  if (field.resource_subtype === "enum") {
    const option = field.enum_options?.find((o) => o.gid === value) ?? null;
    return {
      ...base,
      enum_options: field.enum_options,
      enum_value: option && { gid: option.gid, name: option.name },
      display_value: option?.name ?? null,
    };
  }
  const number = value == null ? null : Number(value);
  return { ...base, number_value: number, display_value: number?.toString() ?? null };
}

function serializeTask(task: StubTask) {
  return {
    gid: task.gid,
    resource_type: "task",
    name: task.name,
    notes: task.notes,
    completed: task.completed,
    projects: task.projects.map(compactProject),
    memberships: task.projects.map((project) => {
      const sectionGid = task.sections.get(project.gid);
      const section = SECTIONS.find((s) => s.gid === sectionGid);
      return {
        project: compactProject(project),
        section: section ? compactSection(section) : null,
      };
    }),
    custom_fields: CUSTOM_FIELDS.map((field) =>
      customFieldValue(field, task.customFields.get(field.gid))
    ),
  };
}

export async function startAsanaStub(): Promise<AsanaStub> {
  const tasks = new Map<string, StubTask>();
  const stories = new Map<string, StubStory>();
  let nextGid = 1;
  const mintGid = () => `19000000000000${(nextGid++).toString().padStart(2, "0")}`;

  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, {
          "content-type": "application/json; charset=UTF-8",
        });
        response.end(JSON.stringify(payload));
      };
      const fail = (status: number, message: string) =>
        send(status, { errors: [{ message }] });

      const authorization = request.headers.authorization ?? "";
      if (!/^Bearer\s+\S/.test(authorization)) {
        return fail(401, "Not Authorized");
      }

      const method = request.method ?? "GET";
      // query params carry nothing the stub needs, and the sdk puts junk in
      // them (it copies the whole opts object, body included)
      const path = new URL(request.url ?? "/", "http://stub").pathname;
      const body = raw ? JSON.parse(raw) : {};
      const data = body.data ?? {};

      let match: RegExpMatchArray | null;

      if (method === "GET" && path === "/users/me") {
        return send(200, {
          data: { gid: "1600000000000001", resource_type: "user", name: "stub user" },
        });
      }

      if (method === "POST" && path === "/tasks") {
        const gid = mintGid();
        tasks.set(gid, {
          gid,
          name: data.name ?? "",
          notes: data.notes ?? "",
          completed: false,
          projects: (data.projects ?? [])
            .map((projectGid: string) =>
              projectGid === PROJECT.gid ? PROJECT : null
            )
            .filter(Boolean),
          sections: new Map(),
          customFields: new Map(),
        });
        return send(201, { data: serializeTask(tasks.get(gid)!) });
      }

      if ((match = path.match(/^\/tasks\/(\d+)$/))) {
        const task = tasks.get(match[1]!);
        if (!task) return fail(404, "task not found");
        if (method === "GET") return send(200, { data: serializeTask(task) });
        if (method === "PUT") {
          if (typeof data.completed === "boolean") task.completed = data.completed;
          for (const [fieldGid, value] of Object.entries(data.custom_fields ?? {})) {
            if (!CUSTOM_FIELDS.some((field) => field.gid === fieldGid)) {
              return fail(400, `unknown custom field ${fieldGid}`);
            }
            task.customFields.set(fieldGid, value);
          }
          return send(200, { data: serializeTask(task) });
        }
        if (method === "DELETE") {
          tasks.delete(task.gid);
          for (const [gid, story] of stories) {
            if (story.taskGid === task.gid) stories.delete(gid);
          }
          return send(200, { data: {} });
        }
      }

      if ((match = path.match(/^\/tasks\/(\d+)\/stories$/))) {
        const task = tasks.get(match[1]!);
        if (!task) return fail(404, "task not found");
        if (method === "GET") {
          return send(200, {
            data: [...stories.values()]
              .filter((story) => story.taskGid === task.gid)
              .map(({ gid, text, is_pinned }) => ({
                gid,
                resource_type: "story",
                text,
                is_pinned,
              })),
            next_page: null,
          });
        }
        if (method === "POST") {
          const gid = mintGid();
          stories.set(gid, {
            gid,
            taskGid: task.gid,
            text: data.text ?? "",
            is_pinned: data.is_pinned ?? false,
          });
          return send(201, {
            data: {
              gid,
              resource_type: "story",
              text: data.text ?? "",
              is_pinned: data.is_pinned ?? false,
            },
          });
        }
      }

      if (method === "DELETE" && (match = path.match(/^\/stories\/(\d+)$/))) {
        if (!stories.delete(match[1]!)) return fail(404, "story not found");
        return send(200, { data: {} });
      }

      if (
        method === "GET" &&
        (match = path.match(/^\/projects\/(\d+)\/sections$/))
      ) {
        if (match[1] !== PROJECT.gid) return fail(404, "project not found");
        return send(200, { data: SECTIONS.map(compactSection), next_page: null });
      }

      if (
        method === "GET" &&
        (match = path.match(/^\/projects\/(\d+)\/custom_field_settings$/))
      ) {
        if (match[1] !== PROJECT.gid) return fail(404, "project not found");
        return send(200, {
          data: CUSTOM_FIELDS.map((field) => ({
            gid: `17${field.gid.slice(2)}`,
            resource_type: "custom_field_setting",
            project: compactProject(PROJECT),
            custom_field: {
              gid: field.gid,
              resource_type: "custom_field",
              name: field.name,
              resource_subtype: field.resource_subtype,
              enum_options: field.enum_options,
            },
          })),
          next_page: null,
        });
      }

      if (
        method === "POST" &&
        (match = path.match(/^\/sections\/(\d+)\/addTask$/))
      ) {
        const section = SECTIONS.find((s) => s.gid === match![1]);
        if (!section) return fail(404, "section not found");
        const task = tasks.get(data.task);
        if (!task) return fail(404, "task not found");
        task.sections.set(PROJECT.gid, section.gid);
        return send(200, { data: {} });
      }

      return fail(404, `stub has no route for ${method} ${path}`);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  // don't hold the event loop open if a test bails out before its teardown runs
  server.unref();

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    organizationId: ORGANIZATION_GID,
    projectId: PROJECT.gid,
    sectionNames: SECTIONS.map((section) => section.name),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
