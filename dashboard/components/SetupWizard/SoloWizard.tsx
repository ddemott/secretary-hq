'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronLeft, X, Wand2 } from 'lucide-react';
import { Api } from '../../lib/api';
import { useStaticData } from '../../lib/hooks';
import { useActiveTenantId, useSessionContext } from '@/lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import { Button } from '../ui/Button';
import { Step1Services } from './StepServices';
import { SoloStepHours } from './SoloStepHours';
import { SoloStepReview } from './SoloStepReview';
import { Step7CallerQuestions } from './Step7CallerQuestions';
import type { ServiceForm, WizardShift, WizardService, SetupWizardProps } from './types';
import type { CoverageItem } from '../../lib/types';
import { EMPTY_SERVICE } from './types';
import { markFirstRunTourPending } from '../auth/FirstRunTour';

type SoloStep = 1 | 2 | 3 | 4;

// Verb/outcome labels — see SetupWizard/index.tsx getStepLabels() for the rationale.
const STEP_LABELS: Record<SoloStep, string> = {
  1: 'What you offer',
  2: 'When you work',
  3: 'Teach Your AI',
  4: 'Look it over',
};

export default function SoloWizard({ isOpen, onClose, onBackToPicker }: SetupWizardProps) {
  const tenantId = useActiveTenantId();
  const { userName } = useSessionContext();
  const { services, employees, resources, loading, refresh } = useStaticData(tenantId);
  const vocab = useVocabulary();
  const [step, setStep] = useState<SoloStep>(1);

  // Step 1 — Services (reuses team wizard)
  const [editingService, setEditingService] = useState<ServiceForm | null>(null);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 2 — Hours (ephemeral form state — persisted to
  // employee_schedule on finalize via Api.shifts.expandWeekly)
  const [shifts, setShifts] = useState<WizardShift[]>([]);
  const [ownerEmployeeId, setOwnerEmployeeId] = useState<string | null>(null);
  // True once the grid holds the owner's REAL current hours — the precondition
  // for finalize replacing the schedule instead of merely adding to it.
  const [hoursHydrated, setHoursHydrated] = useState(false);
  const hoursHydratedRef = useRef(false);

  // Step 3 — Finalization
  const [finalizing, setFinalizing] = useState(false);
  const [finalized, setFinalized] = useState(false);
  const [coverageData, setCoverageData] = useState<CoverageItem[]>([]);

  const seedingRef = useRef(false);
  // Track auto-seeded service ids so "Change business type" can roll
  // them back before reseeding for the new template (matches the team
  // wizard's autoSeededServiceIdsRef behavior; 2026-05-27).
  const autoSeededServiceIdsRef = useRef<Set<string>>(new Set());

  const ownerName = userName || 'Owner';
  const resourceName =
    vocab.resource_label === 'Resource' ? 'Main Station' : vocab.resource_label + ' 1';

  // Reset state when wizard opens
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setEditingService(null);
      setEditingServiceId(null);
      setError(null);
      setFinalized(false);
      setCoverageData([]);
      setOwnerEmployeeId(null);
      setShifts([]);
      setHoursHydrated(false);
      hoursHydratedRef.current = false;
      seedingRef.current = false;
      autoSeededServiceIdsRef.current = new Set();
    }
  }, [isOpen]);

  // Auto-seed example services from the business template when no services exist
  useEffect(() => {
    if (!isOpen || !tenantId || loading || seedingRef.current || services.length > 0) return;
    seedingRef.current = true;
    void seedFromTemplate();
    async function seedFromTemplate() {
      try {
        const [config, templates] = await Promise.all([
          Api.tenants.getConfig(tenantId),
          Api.templates.listFull(),
        ]);
        const tpl = (templates || []).find((t) => t.business_type === config?.business_type);
        if (!tpl?.example_services?.length) return;
        for (const starter of tpl.example_services) {
          // Server-tagged so a future business_type change can wipe these
          // template defaults without touching anything the owner typed.
          // See migration 20260528000000_is_auto_seeded_flag.sql.
          //
          // The description rides along. This is the SOLO wizard's own seeding
          // path — separate from useWizardCrud.seedServices, and just as real —
          // and a look-first starter seeded without its description is
          // unreachable by meaning: resolveServiceForBooking embeds
          // name + subtitle + description, so "Service call" alone gives
          // "water is coming from under my sink" nothing to match.
          const result = await Api.services.create(tenantId, {
            name: starter.name,
            ...(starter.description ? { description: starter.description } : {}),
            duration_minutes: 30,
            is_auto_seeded: true,
          });
          const newId = result?.service?.service_id;
          if (newId) autoSeededServiceIdsRef.current.add(String(newId));
        }
        await refresh();
      } catch {
        // Non-critical — user can still add services manually
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, tenantId, loading, services.length]);

  // "Change business type" — symmetric to the team wizard's
  // handleBackToPicker (SetupWizard/index.tsx). Wipes auto-seeded
  // service rows so the next pick's runSeed reseeds for the chosen
  // template; user-typed rows remain because their ids never entered
  // the ref set.
  async function handleBackToPicker() {
    if (!onBackToPicker) return;
    if (tenantId) {
      const ids = Array.from(autoSeededServiceIdsRef.current);
      autoSeededServiceIdsRef.current = new Set();
      await Promise.all(ids.map((id) => Api.services.delete(id, tenantId).catch(() => undefined)));
      await refresh();
    }
    await onBackToPicker();
  }

  // When moving to Step 2, ensure owner employee exists. The hours
  // grid is ephemeral form state — it persists only at finalize.
  //
  // Waits for `loading` to clear: ensureOwnerEmployee decides create-vs-reuse
  // by looking at `employees`, so running while the roster is still in flight
  // would see an empty list and create the duplicate this guard exists to
  // prevent. `loading` is in the deps so we re-run once the fetch settles.
  useEffect(() => {
    if (step === 2 && tenantId && !loading) {
      void ensureOwnerEmployee();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, tenantId, loading]);

  /**
   * Resolve the owner's staff profile, reusing the existing one on a re-run.
   *
   * This used to create unconditionally, which made the wizard un-rerunnable:
   * `ownerEmployeeId` resets to null every time the wizard opens, so a second
   * run POSTed the owner's name again and the backend's duplicate-name guard
   * (src/routes/employees.ts) answered 409 — "An active employee named 'Dale
   * DeMott' already exists" — dead-ending setup at step 2 for exactly the
   * tenants who had completed setup once. Look before creating so re-running
   * edits the existing business rather than colliding with it.
   *
   * Match by normalized name (same LOWER(TRIM(...)) comparison the backend
   * guard uses, so anything we'd collide with is something we find first). The
   * sole-employee fallback covers a renamed owner: in solo mode the one staff
   * row IS the owner, even if the display name has since drifted from the
   * account name.
   */
  async function ensureOwnerEmployee() {
    if (ownerEmployeeId) return;

    const norm = (s: string) => s.trim().toLowerCase();
    const existing =
      employees.find((e) => norm(String(e.name ?? '')) === norm(ownerName)) ??
      (employees.length === 1 ? employees[0] : undefined);
    if (existing) {
      setOwnerEmployeeId(String(existing.employee_id));
      return;
    }

    // A new business arrives with its template's placeholder staff
    // ("Stylist 1", "Stylist 2"). A solo business is one person, so the first
    // placeholder BECOMES the owner — keeping every service it is set up to do
    // — and the others are removed. Adding the owner beside them would leave
    // bookable staff who do not exist, and callers would be booked with them.
    const placeholders = employees.filter((e) => e.type !== 'user' && e.is_auto_seeded);
    if (placeholders.length > 0) {
      setSaving(true);
      setError(null);
      try {
        const nameParts = (ownerName || 'Owner').split(' ');
        const [keep, ...extras] = placeholders;
        const res = await Api.employees.update(String(keep.employee_id), {
          first_name: nameParts[0] || 'Owner',
          last_name: nameParts.slice(1).join(' ') || '',
          name: ownerName || 'Owner',
        });
        if (!res.success) throw new Error(res.error || 'Failed to set up your staff profile');
        for (const extra of extras) {
          await Api.employees.delete(String(extra.employee_id), tenantId);
        }
        setOwnerEmployeeId(String(keep.employee_id));
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to set up your staff profile');
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const nameParts = (ownerName || 'Owner').split(' ');
      const firstName = nameParts[0] || 'Owner';
      const lastName = nameParts.slice(1).join(' ') || '';

      const res = await Api.employees.create(tenantId, {
        name: ownerName,
        first_name: firstName,
        last_name: lastName,
        skills: [],
      });
      if (res.success && res.employee) {
        setOwnerEmployeeId(String(res.employee.employee_id));
      } else {
        setError(res.error || 'Failed to create your staff profile');
      }
    } catch {
      setError('Failed to create your staff profile');
    } finally {
      setSaving(false);
    }
  }

  // --- Service CRUD (same as team wizard) ---
  async function handleSaveService() {
    if (!editingService || !tenantId) return;
    setSaving(true);
    setError(null);
    try {
      if (editingServiceId) {
        await Api.services.update(editingServiceId, tenantId, editingService);
      } else {
        await Api.services.create(tenantId, editingService);
      }
      await refresh();
      setEditingService(null);
      setEditingServiceId(null);
    } catch {
      setError('Failed to save service');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteService(id: string) {
    if (!tenantId) return;
    setSaving(true);
    setError(null);
    try {
      const result = await Api.services.delete(String(id), tenantId);
      if (!result.success) {
        setError(result.error || 'Failed to delete service');
        return;
      }
      await refresh();
    } catch {
      setError('Failed to delete service');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Preload the owner's CURRENT working days into the hours grid, so re-running
   * setup shows the hours they already set instead of a blank week. Runs once
   * per open, as soon as the owner's staff row is known.
   *
   * `hoursHydrated` then licenses finalize to REPLACE the schedule rather than
   * merge into it. That pairing matters: expand-weekly is additive by default
   * (ON CONFLICT DO NOTHING), so without a preload an unchecked day would linger
   * on the schedule — but replacing from a grid we never populated would erase
   * the owner's real hours. Preload and replace are only ever safe together.
   */
  useEffect(() => {
    if (!isOpen || !tenantId || !ownerEmployeeId || hoursHydratedRef.current) return;
    hoursHydratedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const graph = await Api.setup.graph(tenantId);
        if (cancelled || !graph?.shifts) return;
        const mine = graph.shifts.filter((s) => s.employee_id === ownerEmployeeId);
        if (mine.length === 0) return; // no hours set yet — leave the grid blank
        setShifts(
          // id === String(day_of_week): the shape upsertLocalShift builds, so an
          // existing day edits/toggles in place instead of being treated as new.
          mine.map((s) => ({
            id: String(s.day_of_week),
            day_of_week: s.day_of_week,
            start_time: s.start_time,
            end_time: s.end_time,
          }))
        );
        setHoursHydrated(true);
      } catch {
        // Non-fatal: a blank grid + additive finalize is the SAFE failure — it
        // can only add hours, never erase the ones already on the schedule.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, tenantId, ownerEmployeeId]);

  // --- Shift handlers (mutate local React state only). The whole
  //     pattern is sent to Api.shifts.expandWeekly at finalize. ---

  function upsertLocalShift(dow: number, startTime: string, endTime: string) {
    setShifts((prev) => {
      const existing = prev.find((s) => s.day_of_week === dow);
      if (existing) {
        return prev.map((s) =>
          s.day_of_week === dow ? { ...s, start_time: startTime, end_time: endTime } : s
        );
      }
      return [
        ...prev,
        { id: String(dow), day_of_week: dow, start_time: startTime, end_time: endTime },
      ];
    });
  }

  function handleToggleDay(dayOfWeek: number) {
    setShifts((prev) => {
      const existing = prev.find((s) => s.day_of_week === dayOfWeek);
      if (existing) return prev.filter((s) => s.day_of_week !== dayOfWeek);
      return [
        ...prev,
        { id: String(dayOfWeek), day_of_week: dayOfWeek, start_time: '08:00', end_time: '17:00' },
      ];
    });
  }

  function handleUpdateTime(_shiftId: string, startTime: string, endTime: string) {
    // shiftId here is just the day_of_week string (we use it as a stable
    // local key). Pull the day off the existing row and update.
    setShifts((prev) =>
      prev.map((s) =>
        String(s.id) === String(_shiftId) ? { ...s, start_time: startTime, end_time: endTime } : s
      )
    );
  }

  // Apply one day's hours to all weekdays (Mon-Fri = 1-5)
  function handleApplyToWeekdays(sourceDow: number) {
    const source = shifts.find((s) => s.day_of_week === sourceDow);
    if (!source) return;
    const startTime = source.start_time?.slice(0, 5) || '08:00';
    const endTime = source.end_time?.slice(0, 5) || '17:00';
    for (const dow of [1, 2, 3, 4, 5]) {
      if (dow === sourceDow) continue;
      upsertLocalShift(dow, startTime, endTime);
    }
  }

  // Copy one day's hours to all days below it.
  function handleCopyDown(sourceDow: number) {
    const source = shifts.find((s) => s.day_of_week === sourceDow);
    if (!source) return;
    const startTime = source.start_time?.slice(0, 5) || '08:00';
    const endTime = source.end_time?.slice(0, 5) || '17:00';
    // Days are ordered Mon(1)..Sat(6),Sun(0) in the UI — copy to all after source.
    const dayOrder = [1, 2, 3, 4, 5, 6, 0];
    const sourceIdx = dayOrder.indexOf(sourceDow);
    for (let i = sourceIdx + 1; i < dayOrder.length; i++) {
      upsertLocalShift(dayOrder[i], startTime, endTime);
    }
  }

  // --- Finalization (Step 3) ---
  async function handleFinalize() {
    if (!tenantId || !ownerEmployeeId) return;
    setFinalizing(true);
    setError(null);
    try {
      // 1. The work station. A business that already has one (its template's
      // chair/bay, or the one created at signup) uses it; creating another
      // every time left solo businesses with duplicate stations. Only a
      // business with none gets a new one — tagged auto-seeded so a later
      // business_type change rolls it back along with the services.
      let resourceId: string | null = resources[0] ? String(resources[0].resource_id) : null;
      if (!resourceId) {
        const resResult = await Api.resources.create(tenantId, {
          name: resourceName,
          description: 'Auto-created during solo setup',
          is_auto_seeded: true,
        });
        resourceId =
          resResult.success && resResult.resource ? resResult.resource.resource_id : null;
      }
      if (!resourceId) throw new Error('Failed to create work station');

      // 2. Assign all services to employee + resource
      for (const svc of services) {
        await Api.mappings.assignServiceEmployee(String(svc.service_id), ownerEmployeeId, tenantId);
        await Api.mappings.assignServiceResource(String(svc.service_id), resourceId, tenantId);
      }

      // 3. Fan the in-memory weekly pattern out into 4 weeks of
      //    date-specific employee_schedule rows so booking RPCs
      //    honor what the owner just set. Without this, finalize
      //    succeeds but every booking attempt returns
      //    EMPLOYEE_NOT_SCHEDULED.
      const pattern = shifts
        .filter((s) => s.start_time && s.end_time)
        .map((s) => ({
          day_of_week: s.day_of_week,
          start_time: s.start_time.slice(0, 5),
          end_time: s.end_time.slice(0, 5),
        }));
      // replace only when the grid was preloaded from the real schedule — see
      // the hours-preload effect. Otherwise stay additive so a failed preload
      // can never wipe the owner's existing hours.
      await Api.shifts.expandWeekly(tenantId, ownerEmployeeId, pattern, undefined, hoursHydrated);

      // Pick the fallthrough service by POLICY. The solo path never goes through
      // /setup/commit, which is where the team wizard does this — so without
      // this call a solo tenant finishes setup with default_service_id unset,
      // and the next caller whose words match no service is booked into
      // whichever service sorts first alphabetically. Non-fatal: a failure here
      // leaves the pre-existing behaviour, it does not break go-live.
      try {
        await Api.setup.applyDefaultService(tenantId);
      } catch {
        /* keep going — setup completing matters more than the default */
      }

      // 4. Fetch coverage
      const coverage = await Api.coverage.check(tenantId);
      setCoverageData(Array.isArray(coverage) ? coverage : []);

      setFinalized(true);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed. Please try again.');
    } finally {
      setFinalizing(false);
    }
  }

  if (!isOpen) return null;

  const wizardServices: WizardService[] = (services || []).map((s) => ({
    service_id: s.service_id,
    name: s.name,
    description: s.description || '',
    duration_minutes: s.duration_minutes,
    price: s.price ?? undefined,
  }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div
        className="rounded-2xl shadow-xl border max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden"
        style={{
          backgroundColor: 'var(--surface)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-6 py-4 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <Wand2 className="w-5 h-5" style={{ color: 'var(--accent-soft)' }} />
            <h2 className="text-lg font-bold">Solo Setup</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 transition"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div
          className="px-6 py-3 flex gap-2 shrink-0 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          {([1, 2, 3, 4] as SoloStep[]).map((s) => (
            <button
              key={s}
              onClick={() => !finalized && s <= step && setStep(s)}
              className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
                s === step
                  ? ''
                  : s < step
                    ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500'
              }`}
              style={
                s === step
                  ? { backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }
                  : undefined
              }
            >
              {STEP_LABELS[s]}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {step === 1 && (
            <Step1Services
              services={wizardServices}
              loading={loading}
              editingService={editingService}
              editingServiceId={editingServiceId}
              saving={saving}
              error={error}
              onAdd={() => {
                setEditingService({ ...EMPTY_SERVICE });
                setEditingServiceId(null);
              }}
              onEdit={(svc: WizardService) => {
                setEditingService({
                  name: svc.name,
                  description: svc.description || '',
                  duration_minutes: svc.duration_minutes,
                  price: svc.price ?? undefined,
                });
                setEditingServiceId(svc.service_id);
              }}
              onDelete={handleDeleteService}
              onSave={handleSaveService}
              onCancel={() => {
                setEditingService(null);
                setEditingServiceId(null);
                setError(null);
              }}
              onChange={setEditingService}
            />
          )}

          {step === 2 && (
            <SoloStepHours
              shifts={shifts}
              loading={false}
              saving={saving}
              error={error}
              onToggleDay={handleToggleDay}
              onUpdateTime={handleUpdateTime}
              onApplyToWeekdays={handleApplyToWeekdays}
              onCopyDown={handleCopyDown}
            />
          )}

          {step === 3 && <Step7CallerQuestions tenantId={tenantId} />}

          {step === 4 && (
            <SoloStepReview
              services={services}
              shifts={shifts}
              coverageData={coverageData}
              finalizing={finalizing}
              finalized={finalized}
              error={error}
              ownerName={ownerName}
              resourceName={resourceName}
              onFinalize={handleFinalize}
            />
          )}
        </div>

        {/* Footer navigation */}
        <div
          className="px-6 py-3 border-t flex justify-between shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          {step > 1 && !finalized ? (
            <Button variant="secondary" onClick={() => setStep((step - 1) as SoloStep)}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </Button>
          ) : step === 1 && onBackToPicker && !finalized ? (
            // Step 1 owns the back-to-picker affordance — symmetrical to
            // the team wizard's footer link (SetupWizard/index.tsx).
            <button
              type="button"
              onClick={() => void handleBackToPicker()}
              className="text-xs underline-offset-2 hover:underline transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              &larr; Change business type
            </button>
          ) : (
            <div />
          )}

          {step < 4 ? (
            <Button
              onClick={() => setStep((step + 1) as SoloStep)}
              disabled={step === 1 && services.length === 0}
            >
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : finalized ? (
            <Button
              onClick={() => {
                // Promote auto-seeded rows to user-owned so a later
                // business_type change (post-launch, from Settings)
                // doesn't wipe the catalog the owner just signed off
                // on. Best-effort: a failure here doesn't block the
                // close — worst case rows stay flagged and only a
                // business_type change exposes the gap.
                if (tenantId) {
                  Api.tenants.finalizeSetup(tenantId).catch(() => undefined);
                }
                // Arm the first-run tour — same trigger as the team wizard.
                markFirstRunTourPending(tenantId);
                onClose();
              }}
            >
              Done
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
