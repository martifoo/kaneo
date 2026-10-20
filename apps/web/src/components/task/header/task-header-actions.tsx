import type { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Bell, BellRing, GitBranch, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { HeaderIconButton } from "./header-icon-button";
import { useSetTaskWatch } from "@/hooks/mutations/task/use-set-task-watch";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { TaskMoreMenu } from "./task-more-menu";
import { useTaskCopyActions } from "./use-task-copy-actions";

type TaskHeaderActionsProps = {
  taskId: string;
  projectId: string;
  workspaceId: string;
  deleteHandle: AlertDialogPrimitive.Handle<unknown>;
};

export function TaskHeaderActions({
  taskId,
  projectId,
  workspaceId,
  deleteHandle,
}: TaskHeaderActionsProps) {
  const { t } = useTranslation();
  const actions = useTaskCopyActions({ taskId, projectId, workspaceId });
  const { data: task } = useGetTask(taskId);
  const watch = useSetTaskWatch();
  const isWatching = task?.isWatching ?? false;

  return (
    <div className="flex items-center gap-1">
      <HeaderIconButton
        label={
          isWatching
            ? t("tasks:detail.unwatchTask")
            : t("tasks:detail.watchTask")
        }
        pressed={isWatching}
        disabled={!task || watch.isPending}
        onClick={() =>
          watch.mutate(
            { taskId, watching: !isWatching },
            { onError: () => toast.error(t("tasks:detail.watchError")) },
          )
        }
        className={isWatching ? "text-foreground" : undefined}
      >
        {isWatching ? <BellRing /> : <Bell />}
      </HeaderIconButton>
      <HeaderIconButton
        label={t("tasks:properties.copyTaskLink")}
        shortcutId="copyTaskUrl"
        onClick={actions.copyLink}
        className="max-sm:hidden"
      >
        <Link2 />
      </HeaderIconButton>
      <HeaderIconButton
        label={t("tasks:properties.copyTaskBranch")}
        shortcutId="copyBranchName"
        onClick={actions.copyBranch}
        className="max-sm:hidden"
      >
        <GitBranch />
      </HeaderIconButton>
      <TaskMoreMenu actions={actions} deleteHandle={deleteHandle} />
    </div>
  );
}
