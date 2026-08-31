// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  expandProcessName,
  type BlockingCallMetricData,
  type CujMetricData,
  type CujScopedMetricData,
  type FullTraceMetricData,
  type GlobalDmaHeapMetricData,
  type JankType,
  type NotificationsBlockingCallMetricData,
} from './metricUtils';
import {pinBlockingCallHandlerInstance} from './pinBlockingCall';
import {pinCujInstance} from './pinCujMetricHandler';
import {pinCujScopedJankInstance} from './pinCujScoped';
import {pinFullTraceJankInstance} from './fullTraceJankMetricHandler';
import {pinGlobalDmaHeapSizeMetricsInstance} from './pinGlobalDmaHeapSizeMetricsHandler';
import {pinNotificationsBlockingCallHandlerInstance} from './pinNotificationsBlockingCall';

export enum PinIntentKind {
  Cuj = 'cuj',
  CujScopedJank = 'cuj_scoped_jank',
  CujBlockingCall = 'cuj_blocking_call',
  NotificationBlockingCall = 'notification_blocking_call',
  FullTraceJank = 'full_trace_jank',
  GlobalDmaHeap = 'global_dma_heap',
}

export type PinIntent =
  | ({kind: PinIntentKind.Cuj} & CujMetricData)
  | ({kind: PinIntentKind.CujScopedJank} & CujScopedMetricData)
  | ({kind: PinIntentKind.CujBlockingCall} & BlockingCallMetricData)
  | ({
      kind: PinIntentKind.NotificationBlockingCall;
    } & NotificationsBlockingCallMetricData)
  | ({kind: PinIntentKind.FullTraceJank} & FullTraceMetricData)
  | ({kind: PinIntentKind.GlobalDmaHeap} & GlobalDmaHeapMetricData);

export type PinRequestItem = string | Record<string, unknown> | PinIntent;
export type PinRequestsInput =
  PinRequestItem | PinRequestItem[] | undefined | null;

/**
 * Parses free-form inputs (metric strings, shorthand strings, or dictionary objects)
 * into a typed, deduplicated list of PinIntents.
 *
 * @param {unknown} input Raw input from commands, deep links, or URLs
 * @returns {PinIntent[]} Normalized list of pin intents
 */
export function parsePinIntents(input: unknown): PinIntent[] {
  if (input === undefined || input === null) {
    return [];
  }
  const items = Array.isArray(input) ? input : [input];
  const intents: PinIntent[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      intents.push(...parseStringIntent(item));
    } else if (typeof item === 'object' && item !== null) {
      const parsed = parseDictIntent(item as Record<string, unknown>);
      if (parsed) {
        intents.push(parsed);
      }
    }
  }

  return deduplicateIntents(intents);
}

function parseStringIntent(str: string): PinIntent[] {
  const trimmed = str.trim();
  if (trimmed === '' || trimmed === 'nonexistent_metric') {
    return [];
  }

  // Shorthand string literals
  if (
    trimmed === '*' ||
    trimmed === 'allJankCujs' ||
    trimmed === 'allLatencyCujs' ||
    trimmed === 'all_jank_cujs' ||
    trimmed === 'all_latency_cujs'
  ) {
    return [{kind: PinIntentKind.Cuj, cujName: '*'}];
  }
  if (trimmed === 'globalDmaHeap' || trimmed === 'global_dma_heap') {
    return [{kind: PinIntentKind.GlobalDmaHeap}];
  }

  // Match against existing handler regexes
  const cujScoped = pinCujScopedJankInstance.match(trimmed);
  if (cujScoped) {
    return [
      {kind: PinIntentKind.Cuj, cujName: cujScoped.cujName},
      {kind: PinIntentKind.CujScopedJank, ...cujScoped},
    ];
  }

  const blocking = pinBlockingCallHandlerInstance.match(trimmed);
  if (blocking) {
    return [{kind: PinIntentKind.CujBlockingCall, ...blocking}];
  }

  const notif = pinNotificationsBlockingCallHandlerInstance.match(trimmed);
  if (notif) {
    return [{kind: PinIntentKind.NotificationBlockingCall, ...notif}];
  }

  const fullTrace = pinFullTraceJankInstance.match(trimmed);
  if (fullTrace) {
    return [{kind: PinIntentKind.FullTraceJank, ...fullTrace}];
  }

  const dma = pinGlobalDmaHeapSizeMetricsInstance.match(trimmed);
  if (dma) {
    return [{kind: PinIntentKind.GlobalDmaHeap}];
  }

  const cuj = pinCujInstance.match(trimmed);
  if (cuj) {
    return [{kind: PinIntentKind.Cuj, ...cuj}];
  }

  return [];
}

function getStr(
  dict: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = dict[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function getBool(
  dict: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const k of keys) {
    const v = dict[k];
    if (v === 'true' || v === '1' || v === true) return true;
    if (v === 'false' || v === '0' || v === false) return false;
  }
  return undefined;
}

function parseDictIntent(dict: Record<string, unknown>): PinIntent | undefined {
  const kind = getStr(dict, 'kind', 'type');

  // 1. Global DMA heap
  if (
    kind === PinIntentKind.GlobalDmaHeap ||
    getBool(dict, 'globalDmaHeap', 'global_dma_heap') === true
  ) {
    return {kind: PinIntentKind.GlobalDmaHeap};
  }

  // 2. Notification blocking call
  const notif = getStr(
    dict,
    'notification',
    'notificationName',
    'notification_name',
  );
  if (notif !== undefined || kind === PinIntentKind.NotificationBlockingCall) {
    const agg = getStr(dict, 'agg', 'aggregation');
    if (notif && agg) {
      return {
        kind: PinIntentKind.NotificationBlockingCall,
        notificationName: notif,
        aggregation: agg,
      };
    }
  }

  // 3. CUJ blocking call
  const blockingCall = getStr(
    dict,
    'blockingCall',
    'blocking_call',
    'blockingCallName',
    'blocking_call_name',
  );
  const cuj = getStr(dict, 'cuj', 'cujName', 'cuj_name', 'CUJ');
  const rawProcess = getStr(
    dict,
    'process',
    'pkg',
    'package',
    'process_name',
    'processName',
  );
  const process = rawProcess ? expandProcessName(rawProcess) : undefined;

  if (blockingCall !== undefined || kind === PinIntentKind.CujBlockingCall) {
    const agg = getStr(dict, 'agg', 'aggregation');
    if (process && cuj && blockingCall && agg) {
      return {
        kind: PinIntentKind.CujBlockingCall,
        process,
        cujName: cuj,
        blockingCallName: blockingCall,
        aggregation: agg,
      };
    }
  }

  // 4. Full trace jank
  const isFullTrace =
    getBool(dict, 'fullTrace', 'full_trace', 'ft') ??
    kind === PinIntentKind.FullTraceJank;
  if (isFullTrace && process) {
    const jankType = (getStr(
      dict,
      'jankType',
      'jank_type',
      'frameType',
      'frame_type',
    ) ?? 'frames') as JankType;
    const isWeighted =
      getBool(dict, 'weighted', 'is_weighted', 'isWeighted') ?? false;
    return {
      kind: PinIntentKind.FullTraceJank,
      process,
      jankType,
      isWeighted,
    };
  }

  // 5. CUJ scoped jank
  if (process && cuj && cuj !== '*') {
    const jankType = (getStr(
      dict,
      'jankType',
      'jank_type',
      'frameType',
      'frame_type',
    ) ?? 'frames') as JankType;
    const isWeighted =
      getBool(dict, 'weighted', 'is_weighted', 'isWeighted') ?? false;
    return {
      kind: PinIntentKind.CujScopedJank,
      process,
      cujName: cuj,
      jankType,
      isWeighted,
    };
  }

  // 6. Generic CUJ / Wildcard
  if (cuj) {
    return {kind: PinIntentKind.Cuj, cujName: cuj};
  }
  if (
    getBool(dict, 'allJankCujs', 'all_jank_cujs') ||
    getBool(dict, 'allLatencyCujs', 'all_latency_cujs')
  ) {
    return {kind: PinIntentKind.Cuj, cujName: '*'};
  }

  return undefined;
}

function deduplicateIntents(intents: PinIntent[]): PinIntent[] {
  const seen = new Set<string>();
  const result: PinIntent[] = [];

  for (const intent of intents) {
    const key = JSON.stringify(intent, Object.keys(intent).sort());
    if (!seen.has(key)) {
      seen.add(key);
      result.push(intent);
    }
  }

  return result;
}
