'use client';

import React from 'react';
import { Wrench } from 'lucide-react';
import type { Resource, Service } from '../../lib/types';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';

interface ResourceCardProps {
  resource: Resource;
  services: Service[];
  mappings: { service_id: string; resource_id?: string }[];
  onClick: () => void;
}

export function ResourceCard({ resource, services, mappings, onClick }: ResourceCardProps) {
  const assignedServices = mappings
    .filter((m) => m.resource_id === resource.resource_id)
    .map((m) => services.find((s) => s.service_id === m.service_id))
    .filter(Boolean) as Service[];

  return (
    <Card onClick={onClick} className="cursor-pointer hover:shadow-xl transition-all group">
      <div className="flex justify-between items-start mb-4">
        <div className="p-3 rounded-2xl shadow-sm" style={{ backgroundColor: 'var(--bg-raised)' }}>
          <Wrench className="w-6 h-6 transition-colors" style={{ color: 'var(--text-muted)' }} />
        </div>
        <Badge variant={resource.is_active !== false ? 'success' : 'secondary'}>
          {resource.is_active !== false ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      <h3 className="text-xl font-bold mb-2">{resource.name}</h3>
      <p className="text-sm mb-4 line-clamp-1" style={{ color: 'var(--text-secondary)' }}>
        {resource.description || 'No description provided'}
      </p>

      <div className="flex flex-wrap gap-1">
        {assignedServices.length > 0 ? (
          assignedServices.map((s) => (
            <Badge key={s.service_id} variant="primary" className="text-xs uppercase">
              {s.name}
            </Badge>
          ))
        ) : (
          <span className="text-xs italic" style={{ color: 'var(--text-muted)' }}>
            No services supported
          </span>
        )}
      </div>
    </Card>
  );
}
