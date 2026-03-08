import type React from 'react';

export interface ArcadeGameProps {
  width: number;
  height: number;
  onExit: () => void;
}

export interface ArcadeGameDefinition {
  id: string;
  title: string;
  year: string;
  tagline: string;
  description: string;
  marquee: string[];
  controls: string[];
  component: React.ComponentType<ArcadeGameProps>;
}

export interface ArcadeGameModule {
  default: ArcadeGameDefinition;
}
