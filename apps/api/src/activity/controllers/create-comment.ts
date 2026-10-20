import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  activityTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import createNotification from "../../notification/controllers/create-notification";
import { getTaskWatcherIds } from "../../notification/get-task-watcher-ids";
import { parseMentionIds } from "../../utils/parse-mentions";

async function createComment(
  taskId: string,
  userId: string,
  content: string,
  external?: { userName: string; source: string },
) {
  const [activity] = await db
    .insert(activityTable)
    .values({
      taskId,
      type: "comment",
      userId,
      content,
      ...(external
        ? {
            externalUserName: external.userName,
            externalSource: external.source,
          }
        : {}),
    })
    .returning();

  if (!activity) {
    throw new HTTPException(500, {
      message: "Failed to create activity",
    });
  }

  const [user] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId));

  const [task] = await db
    .select({
      assigneeId: taskTable.userId,
      projectId: taskTable.projectId,
      title: taskTable.title,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId));

  if (task) {
    await publishEvent("comment.created", {
      ...activity,
      comment: `**${user?.name}** commented:\n> ${content}`,
      projectId: task.projectId,
    });
  }

  // Notify any workspace members @mentioned in the comment (not the author).
  const mentionedIds = new Set(
    parseMentionIds(content).filter((id) => id !== userId),
  );
  for (const mentionedId of mentionedIds) {
    await createNotification({
      userId: mentionedId,
      type: "task_mention",
      eventData: {
        taskTitle: task?.title ?? null,
        mentionerName: user?.name ?? null,
        projectId: task?.projectId ?? null,
        workspaceId: task?.workspaceId ?? null,
      },
      resourceId: taskId,
      resourceType: "task",
    });
  }

  if (task) {
    const watchers = await getTaskWatcherIds(taskId);
    const recipients = new Set(
      [...watchers, task.assigneeId].filter(
        (id): id is string =>
          id !== null && id !== userId && !mentionedIds.has(id),
      ),
    );
    for (const recipientId of recipients) {
      await createNotification({
        userId: recipientId,
        type: "task_comment",
        eventData: {
          taskTitle: task.title,
          commenterName: user?.name ?? null,
          commentPreview: content.slice(0, 160),
          projectId: task.projectId,
          workspaceId: task.workspaceId,
        },
        resourceId: taskId,
        resourceType: "task",
      });
    }
  }

  return activity;
}

export default createComment;
