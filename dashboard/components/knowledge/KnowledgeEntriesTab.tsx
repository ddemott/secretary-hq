'use client';

/**
 * "Review Everything" tab — searchable grid of all knowledge entries, each
 * with a delete button. Extracted from KnowledgeBaseView.tsx.
 */

import React from 'react';
import { Search, FileText, Trash2, BookOpen } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Input } from '../ui/Input';
import type { KnowledgeEntry } from '../../lib/types';

interface KnowledgeEntriesTabProps {
  filteredDocs: KnowledgeEntry[];
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onDelete: (id: string) => void;
}

export function KnowledgeEntriesTab({
  filteredDocs,
  searchTerm,
  onSearchChange,
  onDelete,
}: KnowledgeEntriesTabProps) {
  return (
    <>
      <div className="mb-4 relative max-w-md">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
          style={{ color: 'var(--text-muted)' }}
        />
        <Input
          data-shortcut-target="search"
          placeholder="Search knowledge base..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10"
        />
      </div>
      {filteredDocs.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredDocs.map((doc) => (
            <Card
              key={doc.tenant_doc_id}
              className="group relative flex flex-col h-full hover:border-orange-200 dark:hover:border-orange-900/50 transition-all duration-300"
              style={{ borderColor: 'var(--border-soft)' }}
            >
              <div className="p-5 flex-1 flex flex-col">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="text-xs font-bold uppercase tracking-widest flex items-center gap-1"
                      style={{ color: 'var(--warning)' }}
                    >
                      <FileText className="w-3 h-3" />
                      {doc.source === 'policy-questionnaire'
                        ? 'Policy Q&A'
                        : doc.source === 'website-scan'
                          ? 'From website'
                          : doc.source || 'Manual'}
                    </div>
                    {doc.section && (
                      <Badge variant="secondary" className="text-[9px] py-0 px-1.5">
                        {doc.section}
                      </Badge>
                    )}
                  </div>
                  <button
                    onClick={() => onDelete(doc.tenant_doc_id)}
                    className="opacity-40 hover:opacity-100 focus:opacity-100 p-1 transition-all min-h-[44px] min-w-[44px] flex items-center justify-center"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label="Delete entry"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {doc.title && (
                  <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                    {doc.title}
                  </p>
                )}
                <p
                  className="text-sm line-clamp-4 leading-relaxed"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {doc.content}
                </p>
                <div className="mt-auto pt-4">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(doc.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div
          className="flex flex-col items-center justify-center h-48 rounded-2xl border-2 border-dashed"
          style={{
            backgroundColor: 'var(--bg-raised)',
            borderColor: 'var(--border-soft)',
          }}
        >
          <BookOpen className="w-10 h-10 mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {searchTerm
              ? 'No matching entries found.'
              : 'No knowledge entries yet. Start with the questionnaire or upload a document.'}
          </p>
        </div>
      )}
    </>
  );
}
