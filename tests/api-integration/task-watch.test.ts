import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import "../../apps/api/src/notification";
import createComment from "../../apps/api/src/activity/controllers/create-comment";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import updateTaskAssignee from "../../apps/api/src/task/controllers/update-task-assignee";
import updateTaskStatus from "../../apps/api/src/task/controllers/update-task-status";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

vi.mock("../../apps/api/src/events", async (original) => {
  const events = await original<typeof import("../../apps/api/src/events")>();
  return {
    ...events,
    publishEvent: (...args: Parameters<typeof events.publishEvent>) =>
      events.publishEvent(args[0], args[1], { waitForHandlers: true }),
  };
});

vi.mock("../../apps/api/src/notification-preferences/delivery", () => ({
  deliverNotification: vi.fn(async () => undefined),
}));

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTestDatabase();
});

async function fixture() {
  const actor = await createWorkspaceMember();
  const watcher = await createWorkspaceMember();
  const teammate = await createWorkspaceMember();
  await db.insert(schema.workspaceUserTable).values([
    {
      workspaceId: actor.workspace.id,
      userId: watcher.user.id,
      role: "viewer",
      joinedAt: new Date(),
    },
    {
      workspaceId: actor.workspace.id,
      userId: teammate.user.id,
      role: "member",
      joinedAt: new Date(),
    },
  ]);
  const { project, columns } = await createProjectFixture({
    workspaceId: actor.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Watched task",
      status: "to-do",
      columnId: columns.todo.id,
      userId: watcher.user.id,
    })
    .returning();
  return { actor, watcher, teammate, task };
}

const notificationsFor = (userId: string) =>
  db
    .select()
    .from(schema.notificationTable)
    .where(eq(schema.notificationTable.userId, userId));

const notificationTypesFor = async (userId: string) =>
  (await notificationsFor(userId)).map(({ type }) => type).sort();

describe("task watching", () => {
  it("lets a viewer watch and unwatch only their own accessible task", async () => {
    const { actor, watcher, task } = await fixture();
    const outsider = await createWorkspaceMember();
    const { app } = createApp();
    mockAuthenticatedSession(watcher.user);
    const url = `/api/task/${task.id}`;

    expect(await (await app.request(url)).json()).toMatchObject({
      isWatching: false,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(`${url}/watch`, { method: "PUT" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ watching: true });
    }
    expect(await (await app.request(url)).json()).toMatchObject({
      isWatching: true,
    });
    expect(await db.select().from(schema.taskWatcherTable)).toHaveLength(1);

    mockAuthenticatedSession(outsider.user);
    const forbidden = await app.request(`${url}/watch`, { method: "PUT" });
    expect([403, 404]).toContain(forbidden.status);
    expect(await db.select().from(schema.taskWatcherTable)).toHaveLength(1);

    mockAuthenticatedSession(actor.user);
    expect(await (await app.request(url)).json()).toMatchObject({
      isWatching: false,
    });
    mockAuthenticatedSession(watcher.user);
    const response = await app.request(`${url}/watch`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ watching: false });
    expect(await db.select().from(schema.taskWatcherTable)).toEqual([]);
  });

  it("notifies watchers for status, assignee and comments without duplicates or self-notifications", async () => {
    const { actor, watcher, teammate, task } = await fixture();
    await db.insert(schema.taskWatcherTable).values([
      { taskId: task.id, userId: watcher.user.id },
      { taskId: task.id, userId: actor.user.id },
    ]);

    await updateTaskStatus({
      id: task.id,
      status: "in-progress",
      currentUserId: actor.user.id,
    });
    expect(await notificationTypesFor(watcher.user.id)).toEqual([
      "task_status_changed",
    ]);

    await createComment(task.id, actor.user.id, "Ready for review");
    expect(await notificationTypesFor(watcher.user.id)).toEqual([
      "task_comment",
      "task_status_changed",
    ]);

    await createComment(
      task.id,
      actor.user.id,
      `<kaneo-mention id="${watcher.user.id}">watcher</kaneo-mention>`,
    );
    expect(await notificationTypesFor(watcher.user.id)).toEqual([
      "task_comment",
      "task_mention",
      "task_status_changed",
    ]);

    await createComment(task.id, watcher.user.id, "My own comment");
    expect(await notificationsFor(watcher.user.id)).toHaveLength(3);

    await updateTaskAssignee({
      id: task.id,
      userId: teammate.user.id,
      currentUserId: actor.user.id,
    });
    expect(await notificationTypesFor(teammate.user.id)).toEqual([
      "task_assignee_changed",
    ]);
    expect(await notificationTypesFor(watcher.user.id)).toEqual([
      "task_comment",
      "task_mention",
      "task_status_changed",
      "task_watched_assignee_changed",
    ]);

    await updateTaskAssignee({
      id: task.id,
      userId: null,
      currentUserId: actor.user.id,
    });
    expect(
      (await notificationsFor(watcher.user.id)).filter(
        (n) => n.type === "task_watched_assignee_changed",
      ),
    ).toHaveLength(2);

    await updateTaskAssignee({
      id: task.id,
      userId: watcher.user.id,
      currentUserId: actor.user.id,
    });
    expect(await notificationTypesFor(watcher.user.id)).toEqual([
      "task_assignee_changed",
      "task_comment",
      "task_mention",
      "task_status_changed",
      "task_watched_assignee_changed",
      "task_watched_assignee_changed",
    ]);
    expect(await notificationTypesFor(actor.user.id)).toEqual(["task_comment"]);
  });

  it("honors preferences and pauses delivery when task access is lost", async () => {
    const { actor, watcher, teammate, task } = await fixture();
    await db.insert(schema.taskWatcherTable).values({
      taskId: task.id,
      userId: watcher.user.id,
    });
    await db.insert(schema.userNotificationPreferenceTable).values({
      userId: watcher.user.id,
      taskStatusChangeEnabled: false,
      taskAssignmentEnabled: false,
      taskCommentEnabled: false,
    });

    await updateTaskStatus({
      id: task.id,
      status: "in-progress",
      currentUserId: actor.user.id,
    });
    await createComment(task.id, actor.user.id, "Muted comment");
    await updateTaskAssignee({
      id: task.id,
      userId: teammate.user.id,
      currentUserId: actor.user.id,
    });
    expect(await notificationsFor(watcher.user.id)).toEqual([]);

    await db
      .update(schema.userNotificationPreferenceTable)
      .set({ taskStatusChangeEnabled: true })
      .where(
        eq(schema.userNotificationPreferenceTable.userId, watcher.user.id),
      );
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, actor.workspace.id),
          eq(schema.workspaceUserTable.userId, watcher.user.id),
        ),
      );
    await updateTaskStatus({
      id: task.id,
      status: "in-review",
      currentUserId: actor.user.id,
    });
    expect(await notificationsFor(watcher.user.id)).toEqual([]);
    expect(await db.select().from(schema.taskWatcherTable)).toHaveLength(1);

    await db.insert(schema.workspaceUserTable).values({
      workspaceId: actor.workspace.id,
      userId: watcher.user.id,
      role: "viewer",
      joinedAt: new Date(),
    });
    await updateTaskStatus({
      id: task.id,
      status: "done",
      currentUserId: actor.user.id,
    });
    expect(
      (await notificationsFor(watcher.user.id)).map((n) => n.type),
    ).toEqual(["task_status_changed"]);
  });
});
