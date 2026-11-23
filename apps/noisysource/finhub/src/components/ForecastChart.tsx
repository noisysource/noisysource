import { useState } from 'react';
import type { CurrencyCode, ForecastMonthRow } from '../types/finance';
import { formatMoney } from '../utils/financeMath';

interface ForecastChartProps {
  rows: ForecastMonthRow[];
  currencyCode: CurrencyCode;
  height?: number;
}

export function ForecastChart({ rows, currencyCode, height = 270 }: ForecastChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (rows.length === 0) {
    return (
      <div className="h-[240px] flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg">
        No forecast data available for the current filter.
      </div>
    );
  }

  const width = 840;
  const padLeft = 72;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 34;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const allValues: number[] = [0];
  for (const r of rows) {
    allValues.push(r.endingCash, r.inflows, r.payrollOutflow + r.debtService + r.operatingOutflow);
  }
  const minVal = Math.min(0, ...allValues);
  const maxVal = Math.max(1000, ...allValues);
  const span = Math.max(1, maxVal - minVal);

  const yOf = (v: number) => padTop + ((maxVal - v) / span) * chartH;
  const zeroY = yOf(0);
  const stepW = chartW / rows.length;
  const barW = Math.min(20, stepW * 0.28);

  const linePoints = rows
    .map((r, i) => {
      const cx = padLeft + i * stepW + stepW / 2;
      const cy = yOf(r.endingCash);
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(' ');

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minVal + span * t);
  const hoveredRow = hoveredIdx !== null ? rows[hoveredIdx] : null;

  return (
    <div className="relative w-full">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-3 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/80 inline-block" />
            Inflows
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-500/80 inline-block" />
            Total Outflows
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-blue-400 inline-block" />
            Ending Cash Balance
          </span>
        </div>
        {hoveredRow && (
          <div className="flex items-center gap-3 font-mono tabular-nums text-xs text-slate-200">
            <span>{hoveredRow.monthLabel}</span>
            <span className="text-emerald-400">+{formatMoney(hoveredRow.inflows, currencyCode, true)}</span>
            <span className="text-amber-400">
              -{formatMoney(hoveredRow.payrollOutflow + hoveredRow.debtService + hoveredRow.operatingOutflow, currencyCode, true)}
            </span>
            <span className="text-blue-300 font-semibold">
              Cash: {formatMoney(hoveredRow.endingCash, currencyCode)}
            </span>
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto select-none overflow-visible"
        role="img"
        aria-label="12-month cash trajectory and inflow/outflow forecast chart"
      >
        {yTicks.map((val, idx) => {
          const y = yOf(val);
          return (
            <g key={idx}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={y}
                y2={y}
                stroke={Math.abs(val) < 0.01 ? '#475569' : '#1E293B'}
                strokeWidth={Math.abs(val) < 0.01 ? 1.2 : 1}
              />
              <text
                x={padLeft - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-400 text-[10px] font-mono tabular-nums"
              >
                {formatMoney(val, currencyCode, true)}
              </text>
            </g>
          );
        })}

        {rows.map((r, i) => {
          const cx = padLeft + i * stepW + stepW / 2;
          const totalOut = r.payrollOutflow + r.debtService + r.operatingOutflow;
          const inY = yOf(r.inflows);
          const outY = yOf(totalOut);
          const isHovered = hoveredIdx === i;

          return (
            <g
              key={r.monthKey}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="cursor-pointer"
            >
              <rect
                x={padLeft + i * stepW}
                y={padTop}
                width={stepW}
                height={chartH}
                fill={isHovered ? 'rgba(59,130,246,0.06)' : 'transparent'}
              />
              {/* Inflow Bar */}
              <rect
                x={cx - barW - 1.5}
                y={Math.min(inY, zeroY)}
                width={barW}
                height={Math.max(1, Math.abs(zeroY - inY))}
                rx={2}
                fill="#10B981"
                fillOpacity={isHovered ? 0.9 : 0.65}
              />
              {/* Outflow Bar */}
              <rect
                x={cx + 1.5}
                y={Math.min(outY, zeroY)}
                width={barW}
                height={Math.max(1, Math.abs(zeroY - outY))}
                rx={2}
                fill="#F59E0B"
                fillOpacity={isHovered ? 0.9 : 0.65}
              />
              <text
                x={cx}
                y={height - 10}
                textAnchor="middle"
                className={`text-[10px] font-mono ${isHovered ? 'fill-slate-100 font-semibold' : 'fill-slate-400'}`}
              >
                {r.monthLabel}
              </text>
            </g>
          );
        })}

        <polyline
          fill="none"
          stroke="#60A5FA"
          strokeWidth={2.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={linePoints}
        />

        {rows.map((r, i) => {
          const cx = padLeft + i * stepW + stepW / 2;
          const cy = yOf(r.endingCash);
          const isHovered = hoveredIdx === i;
          return (
            <circle
              key={`pt-${r.monthKey}`}
              cx={cx}
              cy={cy}
              r={isHovered ? 5 : 3}
              fill={r.endingCash < 0 ? '#EF4444' : '#60A5FA'}
              stroke="#0F172A"
              strokeWidth={1.5}
              className="pointer-events-none"
            />
          );
        })}
      </svg>
    </div>
  );
}
