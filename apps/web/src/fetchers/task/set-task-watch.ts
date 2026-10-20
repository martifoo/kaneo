import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export async function setTaskWatch(taskId: string, watching: boolean) {
  const request = { param: { id: taskId } };
  const response = watching
    ? await client.task[":id"].watch.$put(request)
    : await client.task[":id"].watch.$delete(request);

  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}
