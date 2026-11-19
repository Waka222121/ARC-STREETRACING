import React from 'react';
import { RivalDifficulty, TrackId } from '../game/types';
import { LiveHudSnapshot } from '../game/WorldCanvas';

interface RacingHudOverlayProps {
  hud: LiveHudSnapshot;
  trackId: TrackId;
  rivalDifficulty: RivalDifficulty;
  isMuted: boolean;
  onToggleMute: () => void;
  onTogglePause: () => void;
  onRestartRace: () => void;
  onCycleCamera: () => void;
}

export const RacingHudOverlay: React.FC<RacingHudOverlayProps> = () => {
  return null;
};
