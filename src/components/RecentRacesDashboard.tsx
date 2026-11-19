import React from 'react';
import { RecentRaceSession } from '../game/types';

export const MAX_RECENT_RACES = 5;

export const RECENT_RACES_STORAGE_KEY = 'arc_streetracing_recent_races_v1';

export const DEFAULT_RECENT_RACES: RecentRaceSession[] = [
  {
    id: 'session-seed-1',
    trackId: 'olympic_circuit',
    trackName: 'Olympic Mid-City Circuit',
    placement: 1,
    totalRacers: 4,
    earningsUsdc: '20.00',
    cashEarned: 14200,
    isVictory: true,
    finishedAtMs: Date.now() - 180_000,
  },
  {
    id: 'session-seed-2',
    trackId: 'olympic_circuit',
    trackName: 'Olympic Mid-City Circuit',
    placement: 2,
    totalRacers: 4,
    earningsUsdc: '0.00',
    cashEarned: 8400,
    isVictory: false,
    finishedAtMs: Date.now() - 420_000,
  },
  {
    id: 'session-seed-3',
    trackId: 'chinatown_sprint',
    trackName: 'Chinatown Neon Sprint',
    placement: 1,
    totalRacers: 4,
    earningsUsdc: '40.00',
    cashEarned: 16800,
    isVictory: true,
    finishedAtMs: Date.now() - 780_000,
  },
  {
    id: 'session-seed-4',
    trackId: 'harbor_drift',
    trackName: 'Terminal Docks Touge',
    placement: 3,
    totalRacers: 4,
    earningsUsdc: '0.00',
    cashEarned: 5100,
    isVictory: false,
    finishedAtMs: Date.now() - 1_200_000,
  },
  {
    id: 'session-seed-5',
    trackId: 'olympic_circuit',
    trackName: 'Olympic Mid-City Circuit',
    placement: 1,
    totalRacers: 4,
    earningsUsdc: '20.00',
    cashEarned: 15500,
    isVictory: true,
    finishedAtMs: Date.now() - 1_650_000,
  },
];

export function appendRecentRaceSession(
  existing: RecentRaceSession[],
  nextSession: RecentRaceSession,
  maxSessions: number = MAX_RECENT_RACES,
): RecentRaceSession[] {
  const filtered = existing.filter((item) => item.id !== nextSession.id);
  return [nextSession, ...filtered].slice(0, Math.max(1, maxSessions));
}

export function loadRecentRacesFromStorage(): RecentRaceSession[] {
  try {
    const raw = localStorage.getItem(RECENT_RACES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(0, MAX_RECENT_RACES);
      }
    }
  } catch {
    // Fallback to default seed sessions
  }
  return DEFAULT_RECENT_RACES;
}

function formatPlacementBadge(placement: number, totalRacers: number): string {
  const suffix =
    placement === 1
      ? 'ST'
      : placement === 2
        ? 'ND'
        : placement === 3
          ? 'RD'
          : 'TH';
  return `${placement}${suffix} PLACE (#${placement}/${totalRacers})`;
}

interface RecentRacesDashboardProps {
  sessions: RecentRaceSession[];
}

export const RecentRacesDashboard: React.FC<RecentRacesDashboardProps> = ({
  sessions,
}) => {
  const visibleSessions = sessions.slice(0, MAX_RECENT_RACES);

  return (
    <div
      id="recent-races-dashboard"
      data-testid="recent-races-dashboard"
      className="col-span-2 w-full max-w-[916px] border border-[rgba(248,248,248,0.12)] bg-[#16161a] px-5 py-4"
    >
      <div className="mb-2 flex items-center justify-between border-b border-[rgba(248,248,248,0.1)] pb-2">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 bg-[#2563eb]" />
          <h2 className="font-['Space_Mono',monospace] text-xs md:text-sm font-bold uppercase tracking-[0.16em] text-[#f8f8f8]">
            Recent Races
          </h2>
        </div>
        <span className="font-['Space_Mono',monospace] text-xs uppercase tracking-[0.14em] text-[#3b82f6]">
          LAST {visibleSessions.length}/{MAX_RECENT_RACES} SESSIONS
        </span>
      </div>

      {visibleSessions.length === 0 ? (
        <div className="py-4 text-center font-['Space_Mono',monospace] text-xs text-[rgba(248,248,248,0.5)]">
          No finished race sessions recorded yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-['Space_Mono',monospace] text-xs">
            <thead>
              <tr className="border-b border-[rgba(248,248,248,0.08)] text-[0.66rem] uppercase tracking-[0.14em] text-[rgba(248,248,248,0.45)]">
                <th className="py-1.5 pr-4">Track ID</th>
                <th className="py-1.5 px-4">Placement</th>
                <th className="py-1.5 pl-4 text-right">Earnings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgba(248,248,248,0.06)]">
              {visibleSessions.map((session, index) => {
                const isWinner = session.placement === 1 || session.isVictory;
                return (
                  <tr
                    key={session.id || index}
                    data-testid={`recent-race-row-${index}`}
                    className="transition hover:bg-[rgba(248,248,248,0.03)]"
                  >
                    <td className="py-1.5 pr-4">
                      <span
                        data-testid={`recent-race-track-${index}`}
                        className="border border-[rgba(248,248,248,0.14)] bg-[#0d0d0f] px-2.5 py-0.5 text-[0.72rem] text-[#f8f8f8]"
                      >
                        {session.trackId}
                      </span>
                    </td>
                    <td className="py-1.5 px-4">
                      <span
                        data-testid={`recent-race-placement-${index}`}
                        className={`inline-block px-2.5 py-0.5 text-[0.72rem] font-bold uppercase ${
                          isWinner
                            ? 'border border-[rgba(74,222,128,0.4)] bg-[rgba(74,222,128,0.12)] text-[#4ade80]'
                            : 'border border-[rgba(248,248,248,0.15)] bg-[rgba(248,248,248,0.06)] text-[rgba(248,248,248,0.75)]'
                        }`}
                      >
                        {formatPlacementBadge(
                          session.placement,
                          session.totalRacers,
                        )}
                      </span>
                    </td>
                    <td
                      data-testid={`recent-race-earnings-${index}`}
                      className={`py-1.5 pl-4 text-right text-xs font-bold ${
                        isWinner
                          ? 'text-[#4ade80]'
                          : 'text-[rgba(248,248,248,0.55)]'
                      }`}
                    >
                      {isWinner
                        ? `+${session.earningsUsdc} USDC`
                        : '0.00 USDC'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
