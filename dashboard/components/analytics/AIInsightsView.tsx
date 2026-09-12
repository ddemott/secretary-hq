'use client';

import React from 'react';
import { FolderTab, FolderTabBar } from '../ui/FolderTabs';
import AIConfigView from '../aiconfig/AIConfigView';
import KnowledgeBaseView from '../knowledge/KnowledgeBaseView';
import { useUrlQueryState } from '../../lib/useUrlQueryState';

type SubTab = 'persona' | 'knowledge';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'persona', label: 'AI Persona' },
  { id: 'knowledge', label: 'Knowledge Base' },
];

// Derived from SUB_TABS so the rendered tabs and the URL-validation allow-list
// can't drift when a tab is added/removed.
const VALID_SUB_TABS: SubTab[] = SUB_TABS.map((t) => t.id);

export default function AIInsightsView() {
  // Mirror the active sub-tab to ?aiTab so reloads / deep-links / browser
  // back-forward preserve it. Scoped param name (aiTab) avoids colliding with
  // the tab/q/view/subtab params other dashboard shells own. persona is the
  // default and is stripped from the URL.
  const [activeSubTab, setActiveSubTab] = useUrlQueryState<SubTab>('aiTab', {
    defaultValue: 'persona',
    valid: VALID_SUB_TABS,
    omitDefault: true,
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <FolderTabBar size="sm" ariaLabel="AI sections">
        {SUB_TABS.map((tab) => (
          <FolderTab
            key={tab.id}
            label={tab.label}
            size="sm"
            isActive={activeSubTab === tab.id}
            onClick={() => setActiveSubTab(tab.id)}
          />
        ))}
      </FolderTabBar>
      {/* overflow-y-auto (not overflow-hidden) so the Knowledge Base
          questionnaire can scroll when expanded sections push content
          below the fold (2026-05-18 user feedback). The flex-1 +
          h-full siblings above keep the FolderTabBar pinned while
          the body scrolls underneath. */}
      <div className="flex-1 overflow-y-auto">
        {activeSubTab === 'persona' && <AIConfigView />}
        {activeSubTab === 'knowledge' && <KnowledgeBaseView />}
      </div>
    </div>
  );
}
