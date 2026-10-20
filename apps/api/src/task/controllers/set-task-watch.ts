import { and, eq } from "drizzle-orm";
import db from "../../database";
import { taskWatcherTable } from "../../database/schema";

export async function setTaskWatch(
  taskId: string,
  userId: string,
  watching: boolean,
) {
  if (watching) {
    await db
      .insert(taskWatcherTable)
      .values({ taskId, userId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(taskWatcherTable)
      .where(
        and(
          eq(taskWatcherTable.taskId, taskId),
          eq(taskWatcherTable.userId, userId),
        ),
      );
  }

  return { watching };
}
