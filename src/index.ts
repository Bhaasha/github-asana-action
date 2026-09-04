import action from "./action.ts";
import * as core from "@actions/core";

async function run() {
  try {
    await action();
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
