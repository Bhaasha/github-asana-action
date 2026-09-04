import type { components } from "../asana-openapi-schema.ts";
import type { TasksApi } from "asana";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Asana from "asana";
import * as github from "@actions/github";
import * as action from "../action.ts";
import { startAsanaStub, type AsanaStub } from "./asana-mock.ts";

type AsanaSchemas = components["schemas"];

// The suite runs against real Asana when all three variables are set (put them
// in .env, see .env.example) and against the in-process stub otherwise, so
// `pnpm test` needs no credentials. Both paths run the same assertions.
const liveNames = [
  "ASANA_PAT",
  "ASANA_PROJECT_ID",
  "ASANA_ORGANIZATION_ID",
] as const;
const liveSet = liveNames.filter((name) => process.env[name]);
if (liveSet.length > 0 && liveSet.length !== liveNames.length) {
  throw new Error(
    `set all of ${liveNames.join(", ")} to run against real asana, or none of ` +
      `them to run against the stub (got only ${liveSet.join(", ")})`
  );
}

let stub: AsanaStub | null = null;
let asanaPAT: string;
let projectId: string;
let organizationId: string;
if (liveSet.length === liveNames.length) {
  asanaPAT = process.env["ASANA_PAT"]!;
  projectId = process.env["ASANA_PROJECT_ID"]!;
  organizationId = process.env["ASANA_ORGANIZATION_ID"]!;
} else {
  stub = await startAsanaStub();
  Asana.ApiClient.instance.basePath = stub.url;
  asanaPAT = "stub-pat";
  projectId = stub.projectId;
  organizationId = stub.organizationId;
}

const projectName = "Asana bot test environment";

// @actions/core reads the inputs off the environment, the same way the runner
// passes them in
function setInputs(inputs: Record<string, string>) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("INPUT_")) {
      delete process.env[name];
    }
  }
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
  }
}

async function runAction(): Promise<unknown[]> {
  const result = await action.action();
  assert.ok(Array.isArray(result), "expected the action to return a list");
  return result;
}

// core.setFailed reports through the process exit code, so read it and clear it
// again — a deliberately failing action must not take the test run down with it
function takeExitCode(): typeof process.exitCode {
  const code = process.exitCode;
  process.exitCode = 0;
  return code;
}

function getTask(
  taskGid: string,
  optFields: string
): Promise<AsanaSchemas["TaskResponse"]> {
  const tasksClient = new Asana.TasksApi() as TasksApi;
  return tasksClient
    .getTask(taskGid, { opt_fields: optFields })
    .then((result) => result.data as AsanaSchemas["TaskResponse"]);
}

describe("asana github actions", () => {
  let defaultBody: string;
  let defaultBodyWithNewUrl: string;
  let task: AsanaSchemas["TaskResponse"];
  let taskGid: string;

  const commentId = Date.now().toString();

  before(async () => {
    const client = await action.buildClient(asanaPAT);
    if (client === null) {
      throw new Error("client authorization failed");
    }

    const tasksClient = new Asana.TasksApi() as TasksApi;
    const data: AsanaSchemas["TaskCreateRequest"] = {
      name: "my fantastic task",
      notes: "generated automatically by the test suite",
      projects: [projectId],
    };
    task = (await tasksClient.createTask({ data }, {}))
      .data as AsanaSchemas["TaskResponse"];
    if (!task.gid) {
      throw new Error("the test task was created without a gid");
    }
    taskGid = task.gid;

    defaultBody = `Implement https://app.asana.com/0/${projectId}/${taskGid} in record time`;
    defaultBodyWithNewUrl = `Implement https://app.asana.com/1/${organizationId}/project/${projectId}/task/${taskGid} in record time`;
  });

  after(async () => {
    const tasksClient = new Asana.TasksApi() as TasksApi;
    await tasksClient.deleteTask(taskGid);
    await stub?.close();
  });

  beforeEach(() => {
    setInputs({});
    github.context.payload = {};
    process.exitCode = 0;
  });

  test("asserting a links presence passes", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "assert-link",
      "link-required": "true",
    });
    github.context.payload = {
      pull_request: { number: 1, body: defaultBody },
    };

    await action.action();

    assert.equal(takeExitCode(), 0);
  });

  test("asserting a links absence fails the job", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "assert-link",
      "link-required": "true",
    });
    github.context.payload = {
      pull_request: { number: 1, body: "no asana link in here" },
    };

    await action.action();

    assert.equal(takeExitCode(), 1);
  });

  test("a missing link passes when it is not required", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "assert-link",
      "link-required": "false",
    });
    github.context.payload = {
      pull_request: { number: 1, body: "no asana link in here" },
    };

    await action.action();

    assert.equal(takeExitCode(), 0);
  });

  test("creating a comment", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "add-comment",
      "comment-id": commentId,
      text: "rad stuff",
      "is-pinned": "true",
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBody,
      },
    };

    assert.equal((await runAction()).length, 1);

    // rerunning with the same comment-Id should not create a new comment
    assert.equal((await runAction()).length, 0);
  });

  test("removing a comment", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "remove-comment",
      // note: relies on the task being created in `creating a comment` test
      "comment-id": commentId,
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBody,
      },
    };

    assert.equal((await runAction()).length, 1);
  });

  test("moving sections using project name", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "move-section",
      targets: `[{"project": "${projectName}", "section": "Done"}]`,
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBody,
      },
    };

    assert.equal((await runAction()).length, 1);
    assert.equal(await sectionOfTask(taskGid), "Done");

    setInputs({
      "asana-pat": asanaPAT,
      action: "move-section",
      targets: `[{"project": "${projectName}", "section": "New"}]`,
    });

    assert.equal((await runAction()).length, 1);
    assert.equal(await sectionOfTask(taskGid), "New");
  });

  test("update fields", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "update-fields",
      targets: `[{"project": "${projectName}", "fields": [{"name": "Custom Number", "value": 1234},{"name": "Custom Enum", "value": "OK"}]}]`,
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBody,
      },
    };

    assert.equal((await runAction()).length, 1);

    const actualTask = await getTask(
      taskGid,
      "custom_fields.name,custom_fields.number_value,custom_fields.enum_value.name"
    );
    const byName = new Map(
      (actualTask.custom_fields ?? []).map((field) => [field.name, field])
    );
    assert.equal(byName.get("Custom Number")?.number_value, 1234);
    assert.equal(byName.get("Custom Enum")?.enum_value?.name, "OK");
  });

  test("moving sections using project id", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "move-section",
      targets: `[{"project_id": "${projectId}", "section": "Done"}]`,
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBody,
      },
    };

    assert.equal((await runAction()).length, 1);
    assert.equal(await sectionOfTask(taskGid), "Done");

    setInputs({
      "asana-pat": asanaPAT,
      action: "move-section",
      targets: `[{"project_id": "${projectId}", "section": "New"}]`,
    });

    assert.equal((await runAction()).length, 1);
    assert.equal(await sectionOfTask(taskGid), "New");
  });

  test("completing task", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "complete-task",
      "is-complete": "true",
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBody,
      },
    };

    assert.equal((await runAction()).length, 1);
    const actualTask = await getTask(taskGid, "completed");
    assert.equal(actualTask.completed, true);
  });

  test("un-completing task using new url format", async () => {
    setInputs({
      "asana-pat": asanaPAT,
      action: "complete-task",
      "is-complete": "false",
    });
    github.context.payload = {
      pull_request: {
        number: 1,
        body: defaultBodyWithNewUrl,
      },
    };

    assert.equal((await runAction()).length, 1);
    const actualTask = await getTask(taskGid, "completed");
    assert.equal(actualTask.completed, false);
  });
});

async function sectionOfTask(taskGid: string): Promise<string | undefined> {
  const actualTask = await getTask(
    taskGid,
    "memberships.project.name,memberships.section.name"
  );
  return actualTask.memberships?.find(
    (membership) => membership.project?.name === projectName
  )?.section?.name;
}
