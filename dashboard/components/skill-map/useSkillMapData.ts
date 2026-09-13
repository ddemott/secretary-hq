import { useMemo, useState, useCallback, useEffect } from 'react';
import { Api } from '../../lib/api';
import { showToast } from '../ui/Toast';

export type NodeType = 'employee' | 'skill' | 'resource';
export type CoverageLevel = 'full' | 'partial' | 'uncovered';

export interface SkillMapNode {
  id: string;
  type: NodeType;
  name: string;
  rawId: number | string;
  coverage?: CoverageLevel;
}

export interface Connection {
  id: string;
  from: string;
  to: string;
  side: 'left' | 'right';
  isBroken: boolean;
}

export interface BrokenChain {
  skillId: string;
  skillName: string;
  missingEmployees: boolean;
  missingResources: boolean;
}

export type LinkingState = {
  fromNodeId: string;
  fromType: NodeType;
} | null;

interface SkillMapEmployee {
  employee_id: string;
  name: string;
  type?: string;
}
interface SkillMapResource {
  resource_id: string;
  name: string;
}
interface ServiceEntity {
  service_id: string;
  name: string;
}
interface ServiceMappingRecord {
  service_id: string;
  employee_id?: string;
  resource_id?: string;
}

export function useSkillMapData(
  employees: SkillMapEmployee[],
  resources: SkillMapResource[],
  services: ServiceEntity[],
  tenantId: string | null,
  onDataChanged?: () => void
) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [linking, setLinking] = useState<LinkingState>(null);
  const [saving, setSaving] = useState(false);
  const [empMappings, setEmpMappings] = useState<ServiceMappingRecord[]>([]);
  const [resMappings, setResMappings] = useState<ServiceMappingRecord[]>([]);
  const [, setMappingsLoaded] = useState(false);

  // Fetch mappings from service_employee and service_resource tables
  const fetchMappings = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [em, rm] = await Promise.all([
        Api.mappings.listServiceEmployee(tenantId),
        Api.mappings.listServiceResource(tenantId),
      ]);
      setEmpMappings(Array.isArray(em) ? em : []);
      setResMappings(Array.isArray(rm) ? rm : []);
      setMappingsLoaded(true);
    } catch {
      setEmpMappings([]);
      setResMappings([]);
      setMappingsLoaded(true);
    }
  }, [tenantId]);

  useEffect(() => {
    void fetchMappings();
  }, [fetchMappings]);

  const { employeeNodes, skillNodes, resourceNodes, connections, coverageBySkill, brokenChains } =
    useMemo(() => {
      // Build employee nodes (filter out user-type)
      const empNodes: SkillMapNode[] = (employees || [])
        .filter((e) => e.type !== 'user')
        .map((e) => ({
          id: `emp-${e.employee_id}`,
          type: 'employee',
          name: e.name,
          rawId: e.employee_id,
        }));

      // Build resource nodes
      const resNodes: SkillMapNode[] = (resources || []).map((r) => ({
        id: `res-${r.resource_id}`,
        type: 'resource',
        name: r.name,
        rawId: r.resource_id,
      }));

      // Build service nodes (middle column — these ARE the "skills" in the map)
      const svcNodes: SkillMapNode[] = (services || []).map((s) => ({
        id: `skill-${s.service_id}`,
        type: 'skill',
        name: s.name,
        rawId: s.service_id,
      }));

      // Build connections from mapping tables (deduplicated by connection id)
      const conns: Connection[] = [];
      const seenIds = new Set<string>();

      // Left side: employee -> service (from service_employee table)
      for (const mapping of empMappings) {
        const empId = `emp-${mapping.employee_id}`;
        const svcId = `skill-${mapping.service_id}`;
        const connId = `${empId}--${svcId}`;
        if (seenIds.has(connId)) continue;
        if (empNodes.some((e) => e.id === empId) && svcNodes.some((s) => s.id === svcId)) {
          seenIds.add(connId);
          conns.push({
            id: connId,
            from: empId,
            to: svcId,
            side: 'left',
            isBroken: false,
          });
        }
      }

      // Right side: service -> resource (from service_resource table)
      for (const mapping of resMappings) {
        const svcId = `skill-${mapping.service_id}`;
        const resId = `res-${mapping.resource_id}`;
        const connId = `${svcId}--${resId}`;
        if (seenIds.has(connId)) continue;
        if (svcNodes.some((s) => s.id === svcId) && resNodes.some((r) => r.id === resId)) {
          seenIds.add(connId);
          conns.push({
            id: connId,
            from: svcId,
            to: resId,
            side: 'right',
            isBroken: false,
          });
        }
      }

      // Compute coverage per service
      const coverage: Record<string, CoverageLevel> = {};
      const broken: BrokenChain[] = [];

      for (const svc of svcNodes) {
        const hasEmployees = conns.some((c) => c.side === 'left' && c.to === svc.id);
        const hasResources = conns.some((c) => c.side === 'right' && c.from === svc.id);

        if (hasEmployees && hasResources) {
          coverage[svc.id] = 'full';
        } else if (hasEmployees || hasResources) {
          coverage[svc.id] = 'partial';
          broken.push({
            skillId: svc.id,
            skillName: svc.name,
            missingEmployees: !hasEmployees,
            missingResources: !hasResources,
          });
        } else {
          coverage[svc.id] = 'uncovered';
          broken.push({
            skillId: svc.id,
            skillName: svc.name,
            missingEmployees: true,
            missingResources: true,
          });
        }

        svc.coverage = coverage[svc.id];
      }

      // Mark broken connections
      for (const chain of broken) {
        for (const conn of conns) {
          if (
            (conn.side === 'left' && conn.to === chain.skillId && chain.missingResources) ||
            (conn.side === 'right' && conn.from === chain.skillId && chain.missingEmployees)
          ) {
            conn.isBroken = true;
          }
        }
      }

      return {
        employeeNodes: empNodes,
        skillNodes: svcNodes,
        resourceNodes: resNodes,
        connections: conns,
        coverageBySkill: coverage,
        brokenChains: broken,
      };
    }, [employees, resources, services, empMappings, resMappings]);

  // Compute highlighted node IDs based on selection
  const highlightedNodeIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();

    const highlighted = new Set<string>([selectedNodeId]);

    if (selectedNodeId.startsWith('emp-')) {
      for (const conn of connections) {
        if (conn.side === 'left' && conn.from === selectedNodeId) {
          highlighted.add(conn.to);
          for (const c2 of connections) {
            if (c2.side === 'right' && c2.from === conn.to) {
              highlighted.add(c2.to);
            }
          }
        }
      }
    } else if (selectedNodeId.startsWith('res-')) {
      for (const conn of connections) {
        if (conn.side === 'right' && conn.to === selectedNodeId) {
          highlighted.add(conn.from);
          for (const c2 of connections) {
            if (c2.side === 'left' && c2.to === conn.from) {
              highlighted.add(c2.from);
            }
          }
        }
      }
    } else if (selectedNodeId.startsWith('skill-')) {
      for (const conn of connections) {
        if (conn.side === 'left' && conn.to === selectedNodeId) highlighted.add(conn.from);
        if (conn.side === 'right' && conn.from === selectedNodeId) highlighted.add(conn.to);
      }
    }

    return highlighted;
  }, [selectedNodeId, connections]);

  const highlightedConnectionIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();

    const highlighted = new Set<string>();
    for (const conn of connections) {
      if (highlightedNodeIds.has(conn.from) && highlightedNodeIds.has(conn.to)) {
        highlighted.add(conn.id);
      }
    }
    return highlighted;
  }, [selectedNodeId, connections, highlightedNodeIds]);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  // --- Linking mode ---

  const validLinkTargets = useMemo(() => {
    if (!linking) return new Set<string>();
    const targets = new Set<string>();

    if (linking.fromType === 'employee') {
      // Employee can link to services
      for (const sk of skillNodes) targets.add(sk.id);
    } else if (linking.fromType === 'resource') {
      // Resource can link to services
      for (const sk of skillNodes) targets.add(sk.id);
    } else if (linking.fromType === 'skill') {
      // Service can link to employees or resources
      for (const emp of employeeNodes) targets.add(emp.id);
      for (const res of resourceNodes) targets.add(res.id);
    }

    return targets;
  }, [linking, skillNodes, employeeNodes, resourceNodes]);

  const startLinking = useCallback((nodeId: string, nodeType: NodeType) => {
    setLinking({ fromNodeId: nodeId, fromType: nodeType });
    setSelectedNodeId(null);
  }, []);

  const cancelLinking = useCallback(() => {
    setLinking(null);
  }, []);

  const completeLinking = useCallback(
    async (targetNodeId: string) => {
      if (!linking || !tenantId || saving) return;

      let employeeNode: SkillMapNode | undefined;
      let serviceNode: SkillMapNode | undefined;
      let resourceNode: SkillMapNode | undefined;

      const fromNode = [...employeeNodes, ...skillNodes, ...resourceNodes].find(
        (n) => n.id === linking.fromNodeId
      );
      const toNode = [...employeeNodes, ...skillNodes, ...resourceNodes].find(
        (n) => n.id === targetNodeId
      );

      if (!fromNode || !toNode) return;

      for (const n of [fromNode, toNode]) {
        if (n.type === 'employee') employeeNode = n;
        if (n.type === 'skill') serviceNode = n;
        if (n.type === 'resource') resourceNode = n;
      }

      if (!serviceNode) return; // Must involve a service

      setSaving(true);
      try {
        if (employeeNode && serviceNode) {
          // Assign employee to service via mapping table
          const serviceId = serviceNode.rawId;
          const employeeId = employeeNode.rawId;
          // Check if already connected
          const alreadyMapped = empMappings.some(
            (m) =>
              String(m.service_id) === String(serviceId) &&
              String(m.employee_id) === String(employeeId)
          );
          if (!alreadyMapped) {
            await Api.mappings.assignServiceEmployee(
              String(serviceId),
              String(employeeId),
              tenantId
            );
          }
        } else if (resourceNode && serviceNode) {
          // Assign resource to service via mapping table
          const serviceId = serviceNode.rawId;
          const resourceId = resourceNode.rawId;
          const alreadyMapped = resMappings.some(
            (m) =>
              String(m.service_id) === String(serviceId) &&
              String(m.resource_id) === String(resourceId)
          );
          if (!alreadyMapped) {
            await Api.mappings.assignServiceResource(
              String(serviceId),
              String(resourceId),
              tenantId
            );
          }
        }
        await fetchMappings();
        onDataChanged?.();
      } catch (err) {
        console.error('Failed to create connection:', err);
        showToast('Mapping update failed', 'error');
      } finally {
        setSaving(false);
        setLinking(null);
      }
    },
    [
      linking,
      tenantId,
      saving,
      employeeNodes,
      skillNodes,
      resourceNodes,
      empMappings,
      resMappings,
      fetchMappings,
      onDataChanged,
    ]
  );

  // --- Disconnect ---

  const disconnectConnection = useCallback(
    async (connectionId: string) => {
      if (!tenantId || saving) return;

      // Parse the connection ID directly: "emp-{empId}--skill-{svcId}" or "skill-{svcId}--res-{resId}"
      const parts = connectionId.split('--');
      if (parts.length !== 2) return;

      const [fromId, toId] = parts;
      const isLeft = fromId.startsWith('emp-');

      setSaving(true);
      try {
        if (isLeft) {
          const empRawId = fromId.replace('emp-', '');
          const svcRawId = toId.replace('skill-', '');
          await Api.mappings.unassignServiceEmployee(svcRawId, empRawId, tenantId);
        } else {
          const svcRawId = fromId.replace('skill-', '');
          const resRawId = toId.replace('res-', '');
          await Api.mappings.unassignServiceResource(svcRawId, resRawId, tenantId);
        }
        await fetchMappings();
      } catch (err) {
        console.error('Failed to disconnect:', err);
        showToast('Mapping update failed', 'error');
      } finally {
        setSaving(false);
      }
    },
    [tenantId, saving, fetchMappings]
  );

  return {
    employeeNodes,
    skillNodes,
    resourceNodes,
    connections,
    coverageBySkill,
    brokenChains,
    selectedNodeId,
    highlightedNodeIds,
    highlightedConnectionIds,
    selectNode,
    linking,
    validLinkTargets,
    startLinking,
    cancelLinking,
    completeLinking,
    disconnectConnection,
    saving,
    empMappings,
    resMappings,
  };
}
