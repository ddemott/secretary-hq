'use client';

/**
 * 3-step creation wizard for a new service — name/duration (step 1),
 * resource assignments (step 2), employee assignments (step 3).
 * Extracted from ServiceAssignmentView.tsx (dense-view decomposition).
 */

import React from 'react';
import { ChevronRight, CheckCircle2, Info } from 'lucide-react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

interface WizardData {
  name?: string;
  description?: string;
  duration_minutes?: number;
}

interface Resource {
  resource_id: string;
  name: string;
  description?: string | null;
}

interface Employee {
  employee_id: string;
  name: string;
  type?: string;
}

interface ServiceCreateWizardProps {
  isOpen: boolean;
  onClose: () => void;
  wizardStep: number;
  onNextStep: () => void;
  onPrevStep: () => void;
  wizardData: WizardData;
  onWizardDataChange: (data: WizardData) => void;
  selectedResourceIds: string[];
  onToggleResourceId: (id: string) => void;
  selectedEmployeeIds: string[];
  onToggleEmployeeId: (id: string) => void;
  resources: Resource[];
  employees: Employee[];
  vocab: { resource_plural: string; employee_plural: string };
  onCreate: () => void;
}

export function ServiceCreateWizard({
  isOpen,
  onClose,
  wizardStep,
  onNextStep,
  onPrevStep,
  wizardData,
  onWizardDataChange,
  selectedResourceIds,
  onToggleResourceId,
  selectedEmployeeIds,
  onToggleEmployeeId,
  resources,
  employees,
  vocab,
  onCreate,
}: ServiceCreateWizardProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`New Service Wizard - Step ${wizardStep} of 3`}
      disableBackdropClose
      footer={
        <div className="flex items-center justify-between w-full">
          <Button variant="ghost" onClick={() => (wizardStep === 1 ? onClose() : onPrevStep())}>
            {wizardStep === 1 ? 'Cancel' : 'Back'}
          </Button>
          {wizardStep < 3 ? (
            <Button onClick={onNextStep} disabled={wizardStep === 1 && !wizardData.name}>
              Next <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button onClick={onCreate} variant="success">
              Create Service
            </Button>
          )}
        </div>
      }
    >
      <div className="min-h-[300px]">
        {/* Step 1: Service details */}
        {wizardStep === 1 && (
          <div className="space-y-6">
            <header>
              <h2 className="text-2xl font-display mb-2">Service Details</h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Tell us what this service is called and how long it takes.
              </p>
            </header>
            <div className="space-y-4">
              <Input
                label="Service Name"
                placeholder="e.g. Front End Alignment"
                value={wizardData.name}
                onChange={(e) => onWizardDataChange({ ...wizardData, name: e.target.value })}
              />
              <div>
                <label
                  htmlFor="wizard-service-description"
                  className="block text-xs font-bold uppercase mb-1 ml-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Description
                </label>
                <textarea
                  id="wizard-service-description"
                  className="w-full p-3 border rounded-xl focus:ring-2 outline-none h-24 text-sm"
                  style={{
                    backgroundColor: 'var(--bg-raised)',
                    borderColor: 'var(--border-soft)',
                  }}
                  placeholder="What is included in this service?"
                  value={wizardData.description}
                  onChange={(e) =>
                    onWizardDataChange({ ...wizardData, description: e.target.value })
                  }
                />
              </div>
              <Input
                label="Base Duration (Minutes)"
                type="number"
                step={15}
                min={15}
                value={wizardData.duration_minutes}
                onChange={(e) =>
                  onWizardDataChange({
                    ...wizardData,
                    duration_minutes: parseInt(e.target.value),
                  })
                }
              />
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Scheduled in 15-minute slots — non-multiples are rounded up on save.
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Resource assignments */}
        {wizardStep === 2 && (
          <div className="space-y-6">
            <header>
              <h2 className="text-2xl font-display mb-2">{vocab.resource_plural} & Equipment</h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Which {vocab.resource_plural.toLowerCase()} can this service be performed at?
              </p>
            </header>
            <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2">
              {resources.map((res) => (
                <Card
                  key={res.resource_id}
                  onClick={() => onToggleResourceId(res.resource_id)}
                  aria-pressed={selectedResourceIds.includes(res.resource_id)}
                  aria-label={res.name}
                  className={`p-4 cursor-pointer border-2 transition-all ${selectedResourceIds.includes(res.resource_id) ? '' : 'border-transparent hover:brightness-110'}`}
                  style={
                    selectedResourceIds.includes(res.resource_id)
                      ? { borderColor: 'var(--accent)', backgroundColor: 'var(--accent-muted)' }
                      : undefined
                  }
                >
                  <div className="font-bold">{res.name}</div>
                  <div className="text-xs line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                    {res.description || 'No description'}
                  </div>
                </Card>
              ))}
            </div>
            <div
              className="p-4 rounded-2xl flex items-start"
              style={{ backgroundColor: 'var(--accent-muted)' }}
            >
              <Info
                className="w-5 h-5 mr-3 shrink-0 mt-0.5"
                style={{ color: 'var(--accent-soft)' }}
              />
              <p className="text-xs leading-relaxed" style={{ color: 'var(--accent-soft)' }}>
                Selecting specific {vocab.resource_plural.toLowerCase()} ensures the AI only books
                this service where the necessary tools or space are available.
              </p>
            </div>
          </div>
        )}

        {/* Step 3: Employee assignments */}
        {wizardStep === 3 && (
          <div className="space-y-6">
            <header>
              <h2 className="text-2xl font-display mb-2">Qualified {vocab.employee_plural}</h2>
              <p style={{ color: 'var(--text-secondary)' }}>
                Which {vocab.employee_plural.toLowerCase()} are qualified to perform this service?
              </p>
            </header>
            <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto pr-2">
              {employees
                .filter((e) => e.type !== 'user')
                .map((emp) => (
                  <Card
                    key={emp.employee_id}
                    onClick={() => onToggleEmployeeId(emp.employee_id.toString())}
                    aria-pressed={selectedEmployeeIds.includes(emp.employee_id.toString())}
                    aria-label={emp.name}
                    className={`p-4 cursor-pointer border-2 transition-all ${selectedEmployeeIds.includes(emp.employee_id.toString()) ? '' : 'border-transparent hover:brightness-110'}`}
                    style={
                      selectedEmployeeIds.includes(emp.employee_id.toString())
                        ? { borderColor: 'var(--accent)', backgroundColor: 'var(--accent-muted)' }
                        : undefined
                    }
                  >
                    <div className="font-bold">{emp.name}</div>
                    <div className="text-xs line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                      Qualified for mapped services
                    </div>
                  </Card>
                ))}
            </div>
            <div className="p-6 bg-green-50 dark:bg-green-900/10 rounded-[2rem] border border-green-100 dark:border-green-800/30">
              <h4 className="text-sm font-bold text-green-800 dark:text-green-400 mb-2 flex items-center">
                <CheckCircle2 className="w-4 h-4 mr-2" /> Ready to Finalize
              </h4>
              <p className="text-xs text-green-700 dark:text-green-500 leading-relaxed">
                You&apos;ve selected {selectedEmployeeIds.length}{' '}
                {vocab.employee_plural.toLowerCase()} and {selectedResourceIds.length}{' '}
                {vocab.resource_plural.toLowerCase()}. Click <strong>Create Service</strong> to
                update your catalog and sync the AI&apos;s scheduling logic.
              </p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
