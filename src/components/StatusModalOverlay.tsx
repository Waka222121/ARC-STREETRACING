import React from 'react';
import { GameState, RaceSummary } from '../game/types';

interface StatusModalOverlayProps {
  gameState: GameState;
  raceSummary: RaceSummary | null;
  winningsUsdc: string;
  onReturnToMenu: () => void;
}

function formatOrdinalPlace(placement: number): string {
  if (placement === 1) return '1ST PLACE';
  if (placement === 2) return '2ND PLACE';
  if (placement === 3) return '3RD PLACE';
  return `${placement}TH PLACE`;
}

export const StatusModalOverlay: React.FC<StatusModalOverlayProps> = ({
  gameState,
  raceSummary,
  winningsUsdc,
  onReturnToMenu,
}) => {
  if (gameState !== 'gameover' || !raceSummary) return null;

  const isWinner = raceSummary.placement === 1 || raceSummary.isVictory;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 backdrop-blur-sm p-5"
      role="dialog"
      aria-modal="true"
      aria-label={isWinner ? 'Winner Results' : 'Race Results'}
    >
      {isWinner ? (
        <div
          id="winner-result-modal"
          className="w-full max-w-md bg-[#16161a] border-2 border-[#4ade80] p-8 text-center shadow-[0_24px_64px_rgba(0,0,0,0.85)]"
        >
          <div className="inline-block px-3 py-1 bg-[rgba(74,222,128,0.12)] border border-[rgba(74,222,128,0.4)] text-[0.68rem] font-['Space_Mono'] uppercase tracking-[0.2em] text-[#4ade80] mb-3">
            1ST PLACE • WINNER
          </div>

          <h2 className="text-3xl font-black tracking-tight text-[#f8f8f8] uppercase">
            CONGRATULATIONS!
          </h2>
          <p className="text-xs font-['Space_Mono'] uppercase tracking-[0.14em] text-[rgba(248,248,248,0.65)] mt-1.5">
            YOU WON THE STREET RACE
          </p>

          <div className="my-6 p-5 bg-[#0d0d0f] border border-[rgba(74,222,128,0.35)]">
            <div className="text-[0.65rem] font-['Space_Mono'] uppercase tracking-[0.18em] text-[rgba(248,248,248,0.5)]">
              TOTAL WINNINGS
            </div>
            <div
              id="winner-payout-amount"
              className="text-3xl font-['Space_Mono'] font-bold text-[#4ade80] mt-1.5"
            >
              +{winningsUsdc} USDC
            </div>
          </div>

          <button
            id="winner-return-menu-btn"
            type="button"
            onClick={onReturnToMenu}
            className="w-full py-4 px-6 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-black text-sm uppercase tracking-[0.14em] transition-colors cursor-pointer"
          >
            RETURN TO MAIN MENU
          </button>
        </div>
      ) : (
        <div
          id="loser-result-modal"
          className="w-full max-w-md bg-[#16161a] border-2 border-[rgba(248,248,248,0.2)] p-8 text-center shadow-[0_24px_64px_rgba(0,0,0,0.85)]"
        >
          <div className="inline-block px-3 py-1 bg-[rgba(248,248,248,0.06)] border border-[rgba(248,248,248,0.18)] text-[0.68rem] font-['Space_Mono'] uppercase tracking-[0.2em] text-[rgba(248,248,248,0.65)] mb-4">
            RACE OVER
          </div>

          <div className="my-4 p-6 bg-[#0d0d0f] border border-[rgba(248,248,248,0.12)]">
            <div className="text-[0.65rem] font-['Space_Mono'] uppercase tracking-[0.18em] text-[rgba(248,248,248,0.5)]">
              YOUR PLACEMENT
            </div>
            <div
              id="loser-placement-text"
              className="text-4xl font-black tracking-tight text-[#f8f8f8] uppercase mt-2"
            >
              {formatOrdinalPlace(raceSummary.placement)}
            </div>
            <div className="text-xs font-['Space_Mono'] text-[#3b82f6] uppercase tracking-[0.16em] mt-1.5">
              #{raceSummary.placement} OF {raceSummary.totalRacers} PLAYERS
            </div>
          </div>

          <button
            id="loser-return-menu-btn"
            type="button"
            onClick={onReturnToMenu}
            className="w-full mt-2 py-4 px-6 bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-black text-sm uppercase tracking-[0.14em] transition-colors cursor-pointer"
          >
            RETURN TO MAIN MENU
          </button>
        </div>
      )}
    </div>
  );
};



