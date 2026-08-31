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

import {parsePinIntents, PinIntentKind} from './pinIntent';

describe('parsePinIntents', () => {
  describe('Shorthand strings & wildcard expansion', () => {
    it('parses shorthand string literals for parameterless tracks', () => {
      expect(parsePinIntents('allJankCujs')).toEqual([
        {kind: PinIntentKind.Cuj, cujName: '*'},
      ]);
      expect(parsePinIntents('allLatencyCujs')).toEqual([
        {kind: PinIntentKind.Cuj, cujName: '*'},
      ]);
      expect(parsePinIntents('globalDmaHeap')).toEqual([
        {kind: PinIntentKind.GlobalDmaHeap},
      ]);
    });

    it('expands wildcard "*" string into wildcard cuj intent', () => {
      expect(parsePinIntents('*')).toEqual([
        {kind: PinIntentKind.Cuj, cujName: '*'},
      ]);
    });
  });

  describe('Regex metric string matching', () => {
    it('matches CUJ scoped missed frame metric keys', () => {
      const metric =
        'perfetto_cuj_launcher-RECENTS_SCROLLING-counter_metrics-missed_sf_frames-mean';
      expect(parsePinIntents(metric)).toEqual([
        {
          kind: PinIntentKind.Cuj,
          cujName: 'RECENTS_SCROLLING',
        },
        {
          kind: PinIntentKind.CujScopedJank,
          process: 'com.google.android.apps.nexuslauncher',
          cujName: 'RECENTS_SCROLLING',
          jankType: 'sf_frames',
          isWeighted: false,
        },
      ]);
    });

    it('matches weighted missed frames', () => {
      const metric =
        'perfetto_cuj_systemui-SHADE_EXPAND-counter_metrics-weighted_missed_app_frames-mean';
      expect(parsePinIntents(metric)).toEqual([
        {
          kind: PinIntentKind.Cuj,
          cujName: 'SHADE_EXPAND',
        },
        {
          kind: PinIntentKind.CujScopedJank,
          process: 'com.android.systemui',
          cujName: 'SHADE_EXPAND',
          jankType: 'app_frames',
          isWeighted: true,
        },
      ]);
    });

    it('matches blocking call metric keys', () => {
      const blockingMetric =
        'perfetto_android_blocking_call-cuj-name-systemui-name-SHADE_EXPAND-blocking_calls-name-animation-total_dur_ms-mean';
      expect(parsePinIntents(blockingMetric)).toEqual([
        {
          kind: PinIntentKind.CujBlockingCall,
          process: 'com.android.systemui',
          cujName: 'SHADE_EXPAND',
          blockingCallName: 'animation',
          aggregation: 'total_dur_ms-mean',
        },
      ]);
    });

    it('matches notification blocking call metric keys', () => {
      const notifMetric =
        'perfetto_android_notifications_blocking_call-blocking_calls-name-NotificationStackScrollLayout-cnt';
      expect(parsePinIntents(notifMetric)).toEqual([
        {
          kind: PinIntentKind.NotificationBlockingCall,
          notificationName: 'NotificationStackScrollLayout',
          aggregation: 'cnt',
        },
      ]);
    });

    it('matches full trace jank metric keys', () => {
      const ftMetric = 'perfetto_ft_systemui-missed_sf_frames';
      expect(parsePinIntents(ftMetric)).toEqual([
        {
          kind: PinIntentKind.FullTraceJank,
          process: 'com.android.systemui',
          jankType: 'sf_frames',
          isWeighted: false,
        },
      ]);
    });

    it('matches global dma heap metric keys', () => {
      const dmaMetric = 'perfetto_android_dma_heap-avg_size_bytes-p95';
      expect(parsePinIntents(dmaMetric)).toEqual([
        {kind: PinIntentKind.GlobalDmaHeap},
      ]);
    });
  });

  describe('Dictionary inputs', () => {
    it('parses wildcard CUJ dictionary "{ cuj: \'*\' }"', () => {
      expect(parsePinIntents({cuj: '*'})).toEqual([
        {kind: PinIntentKind.Cuj, cujName: '*'},
      ]);
    });

    it('parses single CUJ dictionary record', () => {
      expect(parsePinIntents({cuj: 'RECENTS_SCROLLING'})).toEqual([
        {kind: PinIntentKind.Cuj, cujName: 'RECENTS_SCROLLING'},
      ]);
    });

    it('parses missed frames during CUJ with aliases', () => {
      const input = {
        pkg: 'com.android.systemui',
        CUJ: 'RECENTS_SCROLLING',
        frameType: 'sf_frames',
        weighted: 'true',
      };
      expect(parsePinIntents(input)).toEqual([
        {
          kind: PinIntentKind.CujScopedJank,
          process: 'com.android.systemui',
          cujName: 'RECENTS_SCROLLING',
          jankType: 'sf_frames',
          isWeighted: true,
        },
      ]);
    });

    it('parses blocking calls and notification blocking calls', () => {
      const cujBlocking = {
        process: 'com.android.systemui',
        cuj: 'SHADE_EXPAND',
        blockingCall: 'input',
        agg: 'mean_dur_per_frame_ns-max',
      };
      expect(parsePinIntents(cujBlocking)).toEqual([
        {
          kind: PinIntentKind.CujBlockingCall,
          process: 'com.android.systemui',
          cujName: 'SHADE_EXPAND',
          blockingCallName: 'input',
          aggregation: 'mean_dur_per_frame_ns-max',
        },
      ]);

      const notifBlocking = {
        notification: 'NotificationStackScrollLayout',
        agg: 'cnt',
      };
      expect(parsePinIntents(notifBlocking)).toEqual([
        {
          kind: PinIntentKind.NotificationBlockingCall,
          notificationName: 'NotificationStackScrollLayout',
          aggregation: 'cnt',
        },
      ]);
    });

    it('parses full trace jank and global dma heap dictionaries', () => {
      expect(
        parsePinIntents({
          process: 'systemui',
          fullTrace: 'true',
          frameType: 'app_frames',
        }),
      ).toEqual([
        {
          kind: PinIntentKind.FullTraceJank,
          process: 'com.android.systemui',
          jankType: 'app_frames',
          isWeighted: false,
        },
      ]);

      expect(parsePinIntents({globalDmaHeap: 'true'})).toEqual([
        {kind: PinIntentKind.GlobalDmaHeap},
      ]);
    });
  });

  describe('Deduplication across mixed & redundant inputs', () => {
    it('deduplicates identical requests from mixed string and dictionary sources', () => {
      const input = ['allJankCujs', {allJankCujs: 'true'}, {cuj: '*'}, '*'];
      expect(parsePinIntents(input)).toEqual([
        {kind: PinIntentKind.Cuj, cujName: '*'},
      ]);
    });

    it('preserves distinct parameterless handlers', () => {
      const input = ['allJankCujs', 'globalDmaHeap'];
      expect(parsePinIntents(input)).toEqual([
        {kind: PinIntentKind.Cuj, cujName: '*'},
        {kind: PinIntentKind.GlobalDmaHeap},
      ]);
    });
  });

  describe('Robustness and error handling', () => {
    it('handles undefined, null, empty arrays, and empty objects gracefully', () => {
      expect(parsePinIntents(undefined)).toEqual([]);
      expect(parsePinIntents(null)).toEqual([]);
      expect(parsePinIntents([])).toEqual([]);
      expect(parsePinIntents({})).toEqual([]);
      expect(parsePinIntents(['', 'nonexistent_metric'])).toEqual([]);
    });
  });
});
