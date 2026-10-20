import { eq } from "drizzle-orm";
import db from "../database";
import { taskWatcherTable } from "../database/schema";

export async function getTaskWatcherIds(taskId: string) {
  const watchers = await db
    .select({ userId: taskWatcherTable.userId })
    .from(taskWatcherTable)
    .where(eq(taskWatcherTable.taskId, taskId));
  return watchers.map(({ userId }) => userId);
}
