import { randomUUID } from "node:crypto";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
  type WebSocket,
} from "@playwright/test";

async function post(request: APIRequestContext, path: string, data: object) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("Browser tests require a baseURL");
  const response = await request.post(`/api/${path}`, {
    data,
    // Authenticated fixture requests must satisfy the same origin checks as the UI.
    headers: { Origin: new URL(baseURL).origin },
  });
  await expect(response).toBeOK();
  return response.json();
}

async function signUp(request: APIRequestContext) {
  const suffix = randomUUID();
  const email = `task-${suffix}@example.com`;
  await post(request, "auth/sign-up/email", {
    name: "Task Tester",
    email,
    password: `Browser-test-${suffix}`,
  });
  return email;
}

async function createWorkspace(page: Page) {
  await signUp(page.request);
  const workspace = await post(page.request, "auth/organization/create", {
    name: "Task test workspace",
    slug: `browser-${randomUUID()}`,
  });
  await post(page.request, "auth/organization/set-active", {
    organizationId: workspace.id,
  });
  await page.goto(`/dashboard/workspace/${workspace.id}`);
  return workspace.id as string;
}

async function createProject(page: Page) {
  await page.getByRole("link", { name: "All projects", exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .first()
    .click();
  await page
    .getByPlaceholder("Project name", { exact: true })
    .fill("Browser project");
  await page
    .getByRole("button", { name: "Create Project", exact: true })
    .click();
  await expect(page).toHaveURL(/\/project\/[^/]+\/board$/);
  await expect(
    page.getByTitle("Add task", { exact: true }).first(),
  ).toBeVisible();
  return page.url();
}

async function createTask(page: Page, title: string) {
  await page.getByTitle("Add task", { exact: true }).first().click();
  await page.getByPlaceholder("Task title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Create Task", exact: true }).click();
  // The modal's title field also matches the text until the dialog closes.
  await expect(
    page.getByPlaceholder("Task title", { exact: true }),
  ).toBeHidden();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

async function editTask(page: Page, title: string, updated: string) {
  await page.getByText(title, { exact: true }).click();
  const input = page.getByPlaceholder("Click to add a title", { exact: true });
  // Task data and edit permissions load independently when the detail panel opens.
  await expect(input).toHaveValue(title);
  await expect(input).toBeEditable();
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/task/title/") &&
        response.request().method() === "PUT" &&
        response.request().postDataJSON().title === updated,
    ),
    input.fill(updated),
  ]);
  expect(saved.ok()).toBe(true);
}

test("create a project and task, then persist a task edit", async ({
  page,
}) => {
  await createWorkspace(page);
  const boardUrl = await createProject(page);
  await createTask(page, "Plan the release");
  await editTask(page, "Plan the release", "Release plan approved");
  await page.reload();
  await expect(
    page.getByPlaceholder("Click to add a title", { exact: true }),
  ).toHaveValue("Release plan approved");
  await page.goto(boardUrl);
  await expect(
    page.getByText("Release plan approved", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Plan the release", { exact: true })).toHaveCount(
    0,
  );
});

test("another workspace member receives task edits in realtime", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const workspaceId = await createWorkspace(page);
  const boardUrl = await createProject(page);
  await createTask(page, "Collaborative task");

  const colleague = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors,
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const email = await signUp(colleague.request);
    const invitation = await post(
      page.request,
      "auth/organization/invite-member",
      {
        organizationId: workspaceId,
        email,
        role: "member",
      },
    );
    await post(colleague.request, "auth/organization/accept-invitation", {
      invitationId: invitation.id,
    });
    await post(colleague.request, "auth/organization/set-active", {
      organizationId: workspaceId,
    });
    const observer = await colleague.newPage();
    const projectId = new URL(boardUrl).pathname
      .split("/project/")[1]
      .split("/")[0];
    let connectedSocket: WebSocket | undefined;
    const socketErrors: string[] = [];
    observer.on("console", (message) => {
      if (message.type() === "error") socketErrors.push(message.text());
    });
    observer.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname !== `/api/ws/${projectId}`) return;
      socket.on("socketerror", (error) => socketErrors.push(String(error)));
      socket.on("framesent", ({ payload }) => {
        if (String(payload) === '{"type":"ping"}') connectedSocket = socket;
      });
      socket.on("close", () => {
        if (connectedSocket === socket) connectedSocket = undefined;
      });
    });
    await observer.goto(boardUrl);
    await expect(
      observer.getByText("Collaborative task", { exact: true }),
    ).toBeVisible();

    // Playwright's websocket event fires before the handshake succeeds. The app's
    // native keepalive proves it is open and also tolerates its normal reconnects.
    await expect
      .poll(() => Boolean(connectedSocket), {
        timeout: 45_000,
        message: "The project websocket must send its keepalive before editing",
      })
      .toBe(true)
      .catch(async (error) => {
        await test.info().attach("websocket-errors", {
          body: JSON.stringify(socketErrors),
          contentType: "application/json",
        });
        throw error;
      });
    if (!connectedSocket) throw new Error("Project websocket disconnected");

    // Observe the real event as well as the UI, so a refetch cannot hide a broken websocket.
    const update = connectedSocket.waitForEvent(
      "framereceived",
      ({ payload }) => {
        const message = JSON.parse(String(payload));
        return (
          message.type === "TASK_UPDATED" && message.projectId === projectId
        );
      },
    );
    await Promise.all([
      update,
      editTask(page, "Collaborative task", "Updated by my teammate"),
    ]);
    // Keep this page open: no reload, navigation, or focus change to trigger a refetch.
    await expect(
      observer.getByText("Updated by my teammate", { exact: true }),
    ).toBeVisible();
    await expect(
      observer.getByText("Collaborative task", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await colleague.close();
  }
});

test("a viewer watches a task, receives changes in the inbox, and stops watching", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser tests require a baseURL");
  const workspaceId = await createWorkspace(page);
  const boardUrl = await createProject(page);
  const projectId = new URL(boardUrl).pathname
    .split("/project/")[1]
    .split("/")[0];
  const creation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/task/${projectId}` &&
      response.request().method() === "POST",
  );
  await createTask(page, "Watch me");
  const created = await creation;
  expect(created.ok()).toBe(true);
  const task = (await created.json()) as { id: string };
  const taskUrl = boardUrl.replace(/\/board$/, `/task/${task.id}`);
  const session = await page.request.get("/api/auth/get-session");
  await expect(session).toBeOK();
  const { user: owner } = (await session.json()) as { user: { id: string } };
  const origin = new URL(baseURL).origin;
  const update = async (path: string, data: object) => {
    const response = await page.request.put(`/api/task/${path}/${task.id}`, {
      data,
      headers: { Origin: origin },
    });
    await expect(response).toBeOK();
  };
  const viewer = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors,
    locale: "en-US",
  });
  try {
    const email = await signUp(viewer.request);
    const invitation = await post(
      page.request,
      "auth/organization/invite-member",
      {
        organizationId: workspaceId,
        email,
        role: "viewer",
      },
    );
    await post(viewer.request, "auth/organization/accept-invitation", {
      invitationId: invitation.id,
    });
    await post(viewer.request, "auth/organization/set-active", {
      organizationId: workspaceId,
    });
    const observer = await viewer.newPage();
    let connectedSocket: WebSocket | undefined;
    const currentSocket = (): WebSocket | undefined => connectedSocket;
    observer.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname !== "/api/ws/user") return;
      socket.on("framesent", ({ payload }) => {
        if (String(payload) === '{"type":"ping"}') connectedSocket = socket;
      });
      socket.on("close", () => {
        if (connectedSocket === socket) connectedSocket = undefined;
      });
    });
    const notificationTypes = async () => {
      const response = await viewer.request.get(
        `/api/notification?workspaceId=${workspaceId}`,
      );
      await expect(response).toBeOK();
      const notifications = (await response.json()) as Array<{
        resourceId: string;
        type: string;
      }>;
      return notifications
        .filter(({ resourceId }) => resourceId === task.id)
        .map(({ type }) => type)
        .sort();
    };

    await observer.goto(boardUrl);
    await observer.getByText("Watch me", { exact: true }).click();
    await observer
      .getByRole("button", { name: "Watch task", exact: true })
      .click();
    await expect(
      observer.getByRole("button", { name: "Stop watching task", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await observer.reload();
    await expect(
      observer.getByRole("button", { name: "Stop watching task", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await observer.goto(taskUrl);
    await expect(
      observer.getByRole("button", { name: "Stop watching task", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await test.info().attach("watch-enabled", {
      body: await observer.screenshot(),
      contentType: "image/png",
    });

    connectedSocket = undefined;
    await observer.goto(`/dashboard/workspace/${workspaceId}/inbox`);
    await expect
      .poll(() => Boolean(currentSocket()), { timeout: 45_000 })
      .toBe(true);
    const socket = currentSocket();
    if (!socket) throw new Error("User websocket disconnected");
    const notificationEvent = socket.waitForEvent(
      "framereceived",
      ({ payload }) =>
        JSON.parse(String(payload)).type === "NOTIFICATION_CREATED",
    );
    await update("status", { status: "in-progress" });
    await notificationEvent;
    await expect(
      observer.getByText("Task status changed", { exact: true }),
    ).toBeVisible();

    await post(page.request, "activity/comment", {
      taskId: task.id,
      comment: "A watcher comment",
    });
    await expect(
      observer.getByText("New comment on Watch me: A watcher comment", {
        exact: true,
      }),
    ).toBeVisible();
    await update("assignee", { userId: owner.id });
    await update("assignee", { userId: null });
    await expect
      .poll(notificationTypes)
      .toEqual([
        "task_comment",
        "task_status_changed",
        "task_watched_assignee_changed",
        "task_watched_assignee_changed",
      ]);
    await expect(
      observer.getByText("Task assignee changed", { exact: true }),
    ).toHaveCount(2);
    await test.info().attach("watcher-inbox", {
      body: await observer.screenshot(),
      contentType: "image/png",
    });

    await observer.goto(taskUrl);
    await observer
      .getByRole("button", { name: "Stop watching task", exact: true })
      .click();
    await expect(
      observer.getByRole("button", { name: "Watch task", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await observer.reload();
    await expect(
      observer.getByRole("button", { name: "Watch task", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await post(page.request, "activity/comment", {
      taskId: task.id,
      comment: "After unwatching",
    });
    expect(await notificationTypes()).toHaveLength(4);

    await observer.goto("/dashboard/settings/account/notifications");
    await expect(
      observer.getByText(
        "When someone assigns a task to you or changes the assignee of a task you watch.",
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await viewer.close();
  }
});
