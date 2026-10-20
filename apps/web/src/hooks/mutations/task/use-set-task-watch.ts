import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setTaskWatch } from "@/fetchers/task/set-task-watch";

export function useSetTaskWatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ taskId, watching }: { taskId: string; watching: boolean }) =>
      setTaskWatch(taskId, watching),
    onSuccess: (result, { taskId }) => {
      queryClient.setQueryData(["task", taskId], (task: object | undefined) =>
        task ? { ...task, isWatching: result.watching } : task,
      );
    },
  });
}
