'use client';

/**
 * "Upload Documents" tab — drop zone for PDF/TXT/DOC/DOCX/MD files and a list
 * of already-uploaded files (grouped by filename, each deletable).
 * Extracted from KnowledgeBaseView.tsx (dense-view decomposition).
 */

import React from 'react';
import { Upload, FileText, Loader2, Trash2 } from 'lucide-react';
import type { KnowledgeEntry } from '../../lib/types';

const CUSTOM_QUESTION_SOURCE = 'custom-question';

interface KnowledgeDocumentsTabProps {
  docs: KnowledgeEntry[];
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDeleteFile: (source: string) => void;
}

export function KnowledgeDocumentsTab({
  docs,
  uploading,
  fileInputRef,
  onFileChange,
  onDeleteFile,
}: KnowledgeDocumentsTabProps) {
  const uploadedDocs = docs.filter(
    (d) =>
      d.source &&
      d.source !== 'policy-questionnaire' &&
      d.source !== 'website-scan' &&
      d.source !== CUSTOM_QUESTION_SOURCE
  );

  const byFile = uploadedDocs.reduce<Record<string, { chunks: KnowledgeEntry[]; oldest: string }>>(
    (acc, d) => {
      const key = d.source!;
      if (!acc[key]) acc[key] = { chunks: [], oldest: d.created_at };
      acc[key].chunks.push(d);
      if (d.created_at < acc[key].oldest) acc[key].oldest = d.created_at;
      return acc;
    },
    {}
  );

  const files = Object.entries(byFile);

  return (
    <div className="max-w-2xl">
      <input
        type="file"
        ref={fileInputRef}
        onChange={onFileChange}
        className="hidden"
        accept=".pdf,.txt,.doc,.docx,.md"
      />
      <div
        className="flex flex-col items-center justify-center h-64 rounded-2xl border-2 border-dashed cursor-pointer hover:border-orange-400 transition-colors"
        style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? (
          <>
            <Loader2 className="w-10 h-10 animate-spin mb-4" style={{ color: 'var(--warning)' }} />
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Processing document...
            </p>
          </>
        ) : (
          <>
            <Upload className="w-10 h-10 mb-4" style={{ color: 'var(--warning)' }} />
            <p className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
              Drop a file here or click to upload
            </p>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Supports PDF, TXT, DOC, DOCX, and Markdown files
            </p>
          </>
        )}
      </div>
      <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
        Upload your price sheet, service menu, warranty policy, or any document about your business.
        When a caller asks a question, the AI searches your documents for the answer and reads it
        back to them.
      </p>
      {files.length > 0 && (
        <div className="mt-6 space-y-2">
          <p
            className="text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: 'var(--text-muted)' }}
          >
            Uploaded files
          </p>
          {files.map(([filename, { chunks, oldest }]) => (
            <div
              key={filename}
              className="flex items-center justify-between p-3 rounded-lg border"
              style={{
                backgroundColor: 'var(--bg-raised)',
                borderColor: 'var(--border-soft)',
              }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="w-4 h-4 shrink-0" style={{ color: 'var(--warning)' }} />
                <div className="min-w-0">
                  <p
                    className="text-sm font-medium truncate"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {filename}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {chunks.length} chunk{chunks.length === 1 ? '' : 's'} ·{' '}
                    {new Date(oldest).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              </div>
              <button
                onClick={() => onDeleteFile(filename)}
                aria-label={`Remove ${filename}`}
                className="opacity-40 hover:opacity-100 focus:opacity-100 p-1 transition-all min-h-[44px] min-w-[44px] flex items-center justify-center ml-2 shrink-0"
              >
                <Trash2 className="w-4 h-4" style={{ color: 'var(--danger)' }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
