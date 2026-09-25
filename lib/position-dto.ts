import type { Position } from "@prisma/client";

// Latency fix 2 (2026-09-26, docs/audit/2026-09-24/latency-contract.md): the position a trader action produced, in the
// same shape as one item of GET /api/trade/positions, carried in the 2xx body AND the trading-stream event so the
// terminal draws from whichever arrives first instead of refetching.
export type PositionDto = Position & {
  symbol: { name: string; digits: number; contractSize: unknown };
  originOrder: { source: string } | null;
  closePendingOrder: null;
};

export function positionDto(
  position: Position,
  symbol: { name: string; digits: number; contractSize: unknown },
  originSource: string | null
): PositionDto {
  return {
    ...position,
    symbol: { name: symbol.name, digits: symbol.digits, contractSize: symbol.contractSize },
    originOrder: originSource ? { source: originSource } : null,
    closePendingOrder: null,
  };
}

/** The include GET /api/trade/positions uses, for the rare paths that re-read instead of building the DTO. */
export const POSITION_DTO_INCLUDE = {
  symbol: { select: { name: true, digits: true, contractSize: true } },
  originOrder: { select: { source: true } },
  closePendingOrder: { select: { id: true, ticket: true, status: true, closeVolume: true, requotedPrice: true, createdAt: true } },
} as const;
