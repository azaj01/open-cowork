/**
 * PairingRequestsSection — displays pending pairing requests for approval
 */

import { useTranslation } from 'react-i18next';
import { Shield, Check } from 'lucide-react';
import type { PairingRequest } from './types';

interface Props {
  pendingPairings: PairingRequest[];
  onApprove: (request: PairingRequest) => void;
}

export function PairingRequestsSection({ pendingPairings, onApprove }: Props) {
  const { t } = useTranslation();

  if (pendingPairings.length === 0) return null;

  return (
    <div className="p-5 rounded-2xl border-2 border-warning/30 bg-warning/5">
      <h3 className="font-medium text-warning mb-4 flex items-center gap-2">
        <Shield className="w-5 h-5" />
        {t('remote.pairingRequests')}
      </h3>
      <div className="space-y-3">
        {pendingPairings.map((request) => (
          <div
            key={`${request.channelType}-${request.userId}`}
            className="flex items-center justify-between p-4 bg-surface rounded-xl"
          >
            <div>
              <div className="font-medium text-text-primary">
                {request.userName || t('remote.unknownUser')}
              </div>
              <div className="text-sm text-text-secondary mt-1">
                {t('remote.pairingCode')}:{' '}
                <span className="font-mono text-warning font-bold">{request.code}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onApprove(request)}
                className="p-2 rounded-lg bg-success/10 hover:bg-success/20 text-success transition-colors"
                title={t('remote.approve')}
              >
                <Check className="w-5 h-5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
