import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ShortcutTooltipLabel } from "@/components/shortcuts/shortcut-tooltip-label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ShortcutId } from "@/lib/shortcuts/catalog";

type HeaderIconButtonProps = {
  label: string;
  shortcutId?: ShortcutId;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
};

export function HeaderIconButton({
  label,
  shortcutId,
  onClick,
  disabled,
  pressed,
  className,
  children,
}: HeaderIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            disabled={disabled}
            className={cn(
              "text-muted-foreground hover:text-foreground [&_svg]:size-[15px]",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <ShortcutTooltipLabel label={label} shortcutId={shortcutId} />
      </TooltipContent>
    </Tooltip>
  );
}
