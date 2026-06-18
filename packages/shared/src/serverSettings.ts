import {
  DEFAULT_MODEL_BY_PROVIDER,
  type GatewayChannelConfig,
  type ModelSelection,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@peakcode/contracts";
import { deepMerge, type DeepPartial } from "./Struct";

type GatewayChannelPatchEntry = NonNullable<
  NonNullable<ServerSettingsPatch["gateway"]>["channels"]
>[number];

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.provider !== undefined || patch.model !== undefined));
}

function mergeGatewayChannelPatches(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const channelPatches = patch.gateway?.channels;
  if (!channelPatches) return patch;

  const patchesById = new Map(channelPatches.map((channel) => [channel.id, channel]));
  const currentIds = new Set(current.gateway.channels.map((channel) => channel.id));
  const coversEveryCurrentChannel = current.gateway.channels.every((channel) =>
    patchesById.has(channel.id),
  );

  const mergeChannel = (
    channel: GatewayChannelConfig | GatewayChannelPatchEntry,
  ) => {
    const existing = current.gateway.channels.find((candidate) => candidate.id === channel.id);
    return existing
      ? deepMerge(existing, channel as DeepPartial<GatewayChannelConfig>)
      : channel;
  };

  const channels = coversEveryCurrentChannel
    ? channelPatches.map(mergeChannel)
    : [
        ...current.gateway.channels.map((channel) =>
          patchesById.has(channel.id) ? mergeChannel(patchesById.get(channel.id)!) : channel,
        ),
        ...channelPatches
          .filter((channel) => !currentIds.has(channel.id))
          .map(mergeChannel),
      ];

  return {
    ...patch,
    gateway: {
      ...patch.gateway,
      channels,
    },
  } as ServerSettingsPatch;
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const normalizedPatch = mergeGatewayChannelPatches(current, patch);
  const next = deepMerge(current, normalizedPatch as DeepPartial<ServerSettings>);
  if (!selectionPatch) {
    return next;
  }

  const provider = selectionPatch.provider ?? current.textGenerationModelSelection.provider;
  const model =
    selectionPatch.model ??
    (selectionPatch.provider &&
    selectionPatch.provider !== "pi" &&
    selectionPatch.provider !== current.textGenerationModelSelection.provider
      ? DEFAULT_MODEL_BY_PROVIDER[selectionPatch.provider]
      : current.textGenerationModelSelection.model);
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? current.textGenerationModelSelection.options);

  return {
    ...next,
    textGenerationModelSelection: {
      provider,
      model,
      ...(options !== undefined ? { options } : {}),
    } as ModelSelection,
  };
}
