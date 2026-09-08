'use client';

import React from 'react';
import { Users, Wrench, Check, X } from 'lucide-react';
import type { Vocabulary } from '@/lib/VocabularyContext';

type MatrixEntity = {
  entity_id: string;
  type: 'employee' | 'resource';
  name: string;
};

type MatrixService = {
  service_id: string;
  name: string;
};

interface SkillMatrixProps {
  entities: MatrixEntity[];
  services: MatrixService[];
  empMappings: { employee_id?: string; service_id: string }[];
  resMappings: { resource_id?: string; service_id: string }[];
  saving: boolean;
  vocab: Vocabulary;
  onToggle: (entityType: 'employee' | 'resource', entityId: string, serviceId: string) => void;
}

export function SkillMatrix({
  entities,
  services,
  empMappings,
  resMappings,
  saving,
  vocab,
  onToggle,
}: SkillMatrixProps) {
  // Precompute O(N) lookup Sets so each cell check is O(1) rather than O(N)
  const empMappingSet = new Set(empMappings.map((m) => `${m.employee_id}::${m.service_id}`));
  const resMappingSet = new Set(resMappings.map((m) => `${m.resource_id}::${m.service_id}`));

  return (
    <>
      <div
        className="flex-1 overflow-auto border rounded-3xl"
        style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-raised)' }}
      >
        <table className="w-full border-collapse min-w-[800px]">
          <thead
            className="sticky top-0 z-20 border-b"
            style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
          >
            <tr>
              <th
                scope="col"
                className="p-4 text-left text-xs font-bold uppercase tracking-widest sticky left-0 z-30 min-w-[200px]"
                style={{ backgroundColor: 'var(--bg-raised)', color: 'var(--text-muted)' }}
              >
                Entity
              </th>
              {services.map((service) => (
                <th
                  key={service.service_id}
                  scope="col"
                  className="p-4 text-center text-xs font-bold uppercase tracking-widest border-l min-w-[150px]"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--border-soft)' }}
                >
                  {service.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entities.map((entity, idx) => (
              <tr
                key={`${entity.type}-${entity.entity_id}`}
                className={idx % 2 === 0 ? 'bg-white/50 dark:bg-white/5' : ''}
              >
                <th
                  scope="row"
                  className="p-4 border-b sticky left-0 z-10 shadow-[2px_0_5px_rgba(0,0,0,0.05)] font-normal text-left"
                  style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
                >
                  <div className="flex items-center">
                    <div
                      className={`p-1.5 rounded-lg mr-3 ${entity.type === 'employee' ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' : ''}`}
                      style={
                        entity.type === 'resource'
                          ? { backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }
                          : undefined
                      }
                    >
                      {entity.type === 'employee' ? (
                        <Users className="w-3 h-3" />
                      ) : (
                        <Wrench className="w-3 h-3" />
                      )}
                    </div>
                    <div>
                      <div className="font-bold text-sm leading-none mb-1">{entity.name}</div>
                      <div className="text-xs text-gray-400 uppercase font-bold tracking-tighter">
                        {entity.type === 'employee' ? vocab.employee_label : vocab.resource_label}
                      </div>
                    </div>
                  </div>
                </th>
                {services.map((service) => {
                  const isMapped =
                    entity.type === 'employee'
                      ? empMappingSet.has(`${entity.entity_id}::${service.service_id}`)
                      : resMappingSet.has(`${entity.entity_id}::${service.service_id}`);

                  return (
                    <td
                      key={service.service_id}
                      className="p-0 border-b border-l text-center"
                      style={{ borderColor: 'var(--border-soft)' }}
                    >
                      <button
                        disabled={saving}
                        onClick={() => onToggle(entity.type, entity.entity_id, service.service_id)}
                        aria-pressed={isMapped}
                        aria-label={`${isMapped ? 'Remove' : 'Add'} ${service.name} for ${entity.name}`}
                        className={`w-full h-full p-4 flex items-center justify-center transition-all ${isMapped ? '' : 'text-gray-300 dark:text-gray-800 hover:text-gray-400 dark:hover:text-gray-700'}`}
                        style={
                          isMapped
                            ? {
                                backgroundColor: 'var(--accent-muted)',
                                color: 'var(--accent-soft)',
                              }
                            : undefined
                        }
                      >
                        {isMapped ? (
                          <Check className="w-5 h-5 stroke-[3]" />
                        ) : (
                          <X className="w-4 h-4 opacity-30" />
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="mt-6 flex items-center justify-between text-xs text-gray-400 font-medium shrink-0 px-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center">
            <div
              className="w-3 h-3 rounded-full mr-2"
              style={{ backgroundColor: 'var(--success)' }}
            />{' '}
            {vocab.employee_label}
          </div>
          <div className="flex items-center">
            <div
              className="w-3 h-3 rounded-full mr-2"
              style={{ backgroundColor: 'var(--accent)' }}
            />{' '}
            {vocab.resource_label}
          </div>
        </div>
        <p>Changes save immediately.</p>
      </footer>
    </>
  );
}
