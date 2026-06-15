// FILE: ModelChannelPicker.tsx
// Purpose: Renders a service-channel (model-gateway) list inside the provider
//          picker so users can toggle third-party API channels on/off.
//          Channel state is read from and written to the server-authoritative
//          gateway config via NativeApi.gateway.
// Layer: Chat composer presentation

import { memo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { ChevronRightIcon } from "~/lib/icons";
import {
  gatewayConfigQueryOptions,
  serverQueryKeys,
} from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";

// ------------------------------------------------------------------
// Data model
// ------------------------------------------------------------------

export type ModelChannelId =
  | "deepseek"
  | "siliconflow"
  | "volcano"
  | "tongyi"
  | "kimi"
  | "minimax";

export type ModelChannel = {
  readonly id: ModelChannelId;
  readonly name: string;
  readonly nameEn: string;
  readonly subtitle: string;
  readonly subtitleEn: string;
  readonly icon: React.ReactNode;
};

const CHANNELS: ReadonlyArray<ModelChannel> = [
  {
    id: "deepseek",
    name: "DeepSeek",
    nameEn: "DeepSeek",
    subtitle: "深度求索 · DeepSeek",
    subtitleEn: "DeepSeek",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect width="24" height="24" rx="6" fill="#4D6BFA" />
        <path d="M7 12L12 7L17 12L12 17L7 12Z" fill="white" />
      </svg>
    ),
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    nameEn: "SiliconFlow",
    subtitle: "硅基流动 · SiliconFlow",
    subtitleEn: "SiliconFlow",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect width="24" height="24" rx="6" fill="#6366F1" />
        <rect x="6" y="10" width="12" height="4" rx="2" fill="white" />
      </svg>
    ),
  },
  {
    id: "volcano",
    name: "火山方舟",
    nameEn: "Volcano Ark",
    subtitle: "字节跳动 · 火山方舟",
    subtitleEn: "ByteDance Volcano Ark",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect width="24" height="24" rx="6" fill="#3B82F6" />
        <path d="M12 6L18 18H6L12 6Z" fill="white" />
      </svg>
    ),
  },
  {
    id: "tongyi",
    name: "通义千问",
    nameEn: "Tongyi Qianwen",
    subtitle: "阿里云 · 百炼平台",
    subtitleEn: "Alibaba Cloud BaiLian",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect width="24" height="24" rx="6" fill="#F97316" />
        <circle cx="12" cy="12" r="5" fill="white" />
      </svg>
    ),
  },
  {
    id: "kimi",
    name: "Kimi",
    nameEn: "Kimi",
    subtitle: "月之暗面 · Kimi",
    subtitleEn: "Moonshot AI",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect width="24" height="24" rx="6" fill="#1F2937" />
        <circle cx="12" cy="12" r="4" fill="white" />
      </svg>
    ),
  },
  {
    id: "minimax",
    name: "MiniMax",
    nameEn: "MiniMax",
    subtitle: "MiniMax · 海螺 AI",
    subtitleEn: "MiniMax HaiLuo AI",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="shrink-0">
        <rect width="24" height="24" rx="6" fill="#10B981" />
        <path
          d="M7 14C7 10 9 8 12 8C15 8 17 10 17 14"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function ChannelToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(!enabled);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "relative ms-auto inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        enabled ? "bg-[hsl(var(--primary))]" : "bg-muted-foreground/25",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-white shadow-sm transition-transform",
          enabled ? "translate-x-[13px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

function ChannelListItem({
  channel,
  enabled,
  onToggle,
  disabled,
}: {
  channel: ModelChannel;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-2 transition-colors",
        "hover:bg-[var(--color-background-elevated-secondary)]",
        disabled && "opacity-50",
      )}
    >
      {channel.icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">{channel.name}</span>
        <span className="text-xs text-muted-foreground">{channel.subtitle}</span>
      </div>
      <ChannelToggle enabled={enabled} onChange={onToggle} />
    </div>
  );
}

// ------------------------------------------------------------------
// Main exported component (inline section for the model-picker popup)
// ------------------------------------------------------------------

export const ModelChannelSection = memo(function ModelChannelSection() {
  const queryClient = useQueryClient();
  const gatewayConfigQuery = useQuery(gatewayConfigQueryOptions());

  const updateChannelMutation = useMutation({
    mutationFn: async (input: { channelId: ModelChannelId; enabled: boolean }) => {
      const api = ensureNativeApi();
      const current = gatewayConfigQuery.data;
      if (!current) return undefined;
      const channels = current.channels.map((ch) =>
        ch.id === input.channelId ? { ...ch, enabled: input.enabled } : ch,
      );
      return api.gateway.updateConfig({ channels });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.gateway.config() });
    },
  });

  const toggleChannel = useCallback(
    (id: ModelChannelId, next: boolean) => {
      updateChannelMutation.mutate({ channelId: id, enabled: next });
    },
    [updateChannelMutation],
  );

  const serverChannels = gatewayConfigQuery.data?.channels ?? [];
  const enabledCount = serverChannels.filter((ch) => ch.enabled).length;
  const totalCount = CHANNELS.length;

  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel className="flex items-center justify-between px-2 py-1.5">
          <span className="font-medium text-muted-foreground text-xs">服务渠道</span>
          <span className="text-[11px] text-muted-foreground/70">
            ({enabledCount}/{totalCount} 已启用)
          </span>
        </MenuGroupLabel>
        <div className="space-y-0.5 px-1 py-1">
          {CHANNELS.map((channel) => {
            const serverChannel = serverChannels.find((ch) => ch.id === channel.id);
            const isEnabled = serverChannel?.enabled ?? false;
            return (
              <ChannelListItem
                key={channel.id}
                channel={channel}
                enabled={isEnabled}
                disabled={updateChannelMutation.isPending}
                onToggle={() => toggleChannel(channel.id, !isEnabled)}
              />
            );
          })}
        </div>
      </MenuGroup>
    </>
  );
});

// ------------------------------------------------------------------
// Stand-alone picker (if we ever want a separate trigger/button)
// ------------------------------------------------------------------

export const ModelChannelPicker = memo(function ModelChannelPicker({
  open,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const gatewayConfigQuery = useQuery(gatewayConfigQueryOptions());
  const enabledCount = (gatewayConfigQuery.data?.channels ?? []).filter(
    (ch) => ch.enabled,
  ).length;

  return (
    <MenuSub open={open} onOpenChange={onOpenChange}>
      <MenuSubTrigger
        className="flex items-center gap-2 px-2 py-1.5 text-sm"
        onClick={() => onOpenChange?.(!open)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="flex-1">服务渠道</span>
        <span className="text-[11px] text-muted-foreground/70">
          ({enabledCount}/{CHANNELS.length} 已启用)
        </span>
      </MenuSubTrigger>
      <MenuSubPopup className="[--available-height:min(24rem,70vh)] w-72">
        <ModelChannelSection />
      </MenuSubPopup>
    </MenuSub>
  );
});
