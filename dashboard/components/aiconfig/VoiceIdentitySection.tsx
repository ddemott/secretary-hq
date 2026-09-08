'use client';

import React from 'react';
import { Mic } from 'lucide-react';
import { type Tenant } from '@/lib/types';
import { Card } from '../ui/Card';

type VoiceFields = Pick<
  Tenant,
  | 'tts_voice'
  | 'tts_speed'
  | 'tts_formal'
  | 'tts_warm'
  | 'tts_concise'
  | 'tts_soft'
  | 'tts_cheerful'
>;

interface VoiceIdentitySectionProps {
  config: VoiceFields;
  onUpdate: (fields: Partial<Tenant>) => void;
}

const VOICES = [
  { id: 'shimmer', name: 'Shimmer — Female', desc: 'Warm, calm, gentle (default)' },
  { id: 'nova', name: 'Nova — Female', desc: 'Bright, friendly, upbeat' },
  { id: 'alloy', name: 'Alloy — Neutral', desc: 'Balanced, even-toned' },
  { id: 'echo', name: 'Echo — Male', desc: 'Clear, steady' },
  { id: 'onyx', name: 'Onyx — Male', desc: 'Deep, authoritative' },
  { id: 'fable', name: 'Fable — Expressive', desc: 'Animated, storytelling tone' },
];

const STYLE_OPTIONS: { key: keyof VoiceFields; label: string; description: string }[] = [
  { key: 'tts_formal', label: 'Formal', description: 'Professional, no contractions' },
  { key: 'tts_warm', label: 'Warm', description: 'Empathetic, caring' },
  { key: 'tts_concise', label: 'Concise', description: 'Fewer words, faster to the point' },
  { key: 'tts_soft', label: 'Soft', description: 'Gentle, calm, soothing delivery' },
  { key: 'tts_cheerful', label: 'Cheerful', description: 'Bright, friendly, upbeat' },
];

export function VoiceIdentitySection({ config, onUpdate }: VoiceIdentitySectionProps) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-bold flex items-center" style={{ color: 'var(--text-primary)' }}>
        <Mic className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
        Voice Identity
      </h2>

      {/* Voice cards */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        role="radiogroup"
        aria-label="Voice selection"
      >
        {VOICES.map((voice) => (
          <Card
            key={voice.id}
            onClick={() => onUpdate({ tts_voice: voice.id })}
            className={`p-4 cursor-pointer flex items-center justify-between ${config.tts_voice === voice.id ? 'ring-1' : ''}`}
            style={
              config.tts_voice === voice.id
                ? {
                    borderColor: 'var(--accent)',
                    ['--tw-ring-color' as string]: 'var(--accent)',
                  }
                : undefined
            }
            role="radio"
            aria-checked={config.tts_voice === voice.id}
            aria-label={voice.name}
          >
            <div>
              <p className="font-bold">{voice.name}</p>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {voice.desc}
              </p>
            </div>
            <div
              className="w-4 h-4 rounded-full border-2"
              style={
                config.tts_voice === voice.id
                  ? { backgroundColor: 'var(--accent)', borderColor: 'var(--accent)' }
                  : { borderColor: 'var(--border-soft)' }
              }
            />
          </Card>
        ))}
      </div>

      {/* Speed slider */}
      <div className="pt-2">
        <label
          htmlFor="tts-speed"
          className="block text-sm font-semibold mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          Speaking pace — {(config.tts_speed ?? 1.0).toFixed(2)}×
        </label>
        <input
          id="tts-speed"
          type="range"
          min={0.7}
          max={1.5}
          step={0.05}
          value={config.tts_speed ?? 1.0}
          onChange={(e) => onUpdate({ tts_speed: parseFloat(e.target.value) })}
          className="w-full"
          aria-label="Speaking pace"
        />
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          1.0 is normal pace. Lower = slower and calmer; higher = brisker.
        </p>
      </div>

      {/* Style checkboxes */}
      <div className="pt-2">
        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
          Voice style
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {STYLE_OPTIONS.map(({ key, label, description }) => (
            <label
              key={key}
              className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border"
              style={{
                borderColor: config[key] ? 'var(--accent)' : 'var(--border-soft)',
                backgroundColor: config[key] ? 'var(--accent-muted)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={!!config[key]}
                onChange={(e) => onUpdate({ [key]: e.target.checked })}
                aria-label={label}
                className="mt-0.5"
              />
              <span>
                <span
                  className="block text-sm font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {label}
                </span>
                <span className="block text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
