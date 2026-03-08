import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { Box, Spacer, Text } from 'ink';
import Gradient from 'ink-gradient';

import { truncateEnd, truncateMiddle } from '../core/utils.js';
import { useTerminalViewport } from './terminal.js';
import { palette } from './theme.js';

interface WindowFrameProps {
  children: React.ReactNode;
  footerLeft: string;
  footerRight: string;
}

function readRalphiVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const ralphiVersion = readRalphiVersion();

export function WindowFrame({ children, footerLeft, footerRight }: WindowFrameProps) {
  const { columns, rows } = useTerminalViewport();

  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Box width={columns} height={rows} flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1} paddingY={0}>
        <ChromeBar />
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {children}
        </Box>
        <FooterDivider width={Math.max(8, columns - 4)} />
        <FooterBar left={footerLeft} right={footerRight} />
      </Box>
    </Box>
  );
}

function ChromeBar() {
  return (
    <Box>
      <Box width={6}>
        <Box>
          <Text color="#ff6a88">●</Text>
          <Text color="#f7d46b"> ●</Text>
          <Text color="#7ef7b8"> ●</Text>
        </Box>
      </Box>
      <Box flexGrow={1} justifyContent="center">
        <Text color={palette.dim}>{`RALPHI - V${ralphiVersion}`}</Text>
      </Box>
      <Box width={6} />
    </Box>
  );
}

export function SystemTabs({ tabs, activeIndex }: { tabs: string[]; activeIndex: number }) {
  return (
    <Box flexWrap="wrap" flexShrink={0}>
      {tabs.map((tab, index) => {
        const active = index === activeIndex;
        return (
          <Box
            key={tab}
            borderStyle="round"
            borderColor={active ? palette.border : palette.borderSoft}
            paddingX={1}
            marginRight={1}
          >
            <Text color={active ? palette.text : palette.dim}>{truncateEnd(tab, 16)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface SectionPanelProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: number;
  height?: number;
  flexGrow?: number;
}

export function SectionPanel({ title, subtitle, children, width, height, flexGrow }: SectionPanelProps) {
  const hasHeader = Boolean(title || subtitle);
  return (
    <Box
      width={width}
      height={height}
      flexGrow={flexGrow}
      flexShrink={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.borderSoft}
      paddingX={1}
      paddingY={0}
    >
      {hasHeader ? (
        <Box flexShrink={0}>
          {title ? (
            <Box flexGrow={1} flexShrink={1}>
              <Text color={palette.accent} wrap="truncate-end">
                {title}
              </Text>
            </Box>
          ) : null}
          {subtitle ? (
            <Box marginLeft={title ? 1 : 0} flexShrink={0}>
              <Text color={palette.dim}>{subtitle}</Text>
            </Box>
          ) : title ? (
            <Text color={palette.dim}>█</Text>
          ) : null}
        </Box>
      ) : null}
      <Box marginTop={hasHeader ? 1 : 0} flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden">
        {children}
      </Box>
    </Box>
  );
}

export function AsciiLogo() {
  const logo = [
    '█▀█ ▄▀█ █   █▀█ █ █ ▀',
    '█▀▄ █▀█ █▄▄ █▀▀ █▀█ █',
    'NEON CONTROL LOOP'
  ].join('\n');

  return (
    <Box flexDirection="column">
      <Gradient colors={[palette.accent, palette.accentSoft, palette.cyan]}>
        <Text>{logo}</Text>
      </Gradient>
      <Text color={palette.dim}>Autonomous PRD control deck</Text>
    </Box>
  );
}

export function LabelValue({
  label,
  value,
  labelWidth = 12,
  valueWidth = 22
}: {
  label: string;
  value: string;
  labelWidth?: number;
  valueWidth?: number;
}) {
  const safeLabelWidth = Math.max(6, labelWidth);
  const safeValueWidth = Math.max(4, valueWidth);

  return (
    <Box flexShrink={0}>
      <Box width={safeLabelWidth + 1} flexShrink={0}>
        <Text color={palette.dim}>{`${truncateEnd(label, safeLabelWidth).padEnd(safeLabelWidth)} `}</Text>
      </Box>
      <Box width={safeValueWidth} flexShrink={1}>
        <Text color={palette.text} wrap="truncate-middle">
          {truncateMiddle(value, safeValueWidth)}
        </Text>
      </Box>
    </Box>
  );
}

export function ChoiceRow({
  active,
  label,
  description,
  marker
}: {
  active: boolean;
  label: string;
  description: string;
  marker?: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={1}>
      <Box flexShrink={1}>
        <Text color={active ? palette.accent : palette.dim}>{active ? '> ' : '  '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={active ? palette.text : palette.dim} wrap="truncate-end">
            {`${marker ? `${marker} ` : ''}${label}`}
          </Text>
        </Box>
      </Box>
      <Box marginLeft={3} flexShrink={1}>
        <Text color={palette.dim} wrap="truncate-end">
          {description}
        </Text>
      </Box>
    </Box>
  );
}

export function SelectRow({
  active,
  checked,
  label,
  detail
}: {
  active: boolean;
  checked?: boolean;
  label: string;
  detail?: string;
}) {
  return (
    <Box flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={active ? palette.accent : palette.dim}>{active ? '>' : ' '}</Text>
      </Box>
      {typeof checked === 'boolean' ? (
        <Box width={4} flexShrink={0} marginRight={1}>
          <Text color={checked ? palette.green : palette.dim}>{checked ? '[x]' : '[ ]'}</Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1}>
        <Text color={active ? palette.text : palette.dim} wrap="truncate-middle">
          {label}
        </Text>
      </Box>
      {detail ? (
        <Box marginLeft={1} flexShrink={0}>
          <Text color={active ? palette.accentSoft : palette.dim}>{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function FooterBar({ left, right }: { left: string; right: string }) {
  return (
    <Box flexShrink={0}>
      <Box flexShrink={1} marginRight={1}>
        <Text backgroundColor={palette.accent} color={palette.bg}>
          {' STATUS '}
        </Text>
        <Box flexShrink={1}>
          <Text backgroundColor={palette.panelAlt} color={palette.text} wrap="truncate-end">
            {` ${left} `}
          </Text>
        </Box>
      </Box>
      <Spacer />
      <Box flexShrink={0}>
        <Text backgroundColor={palette.border} color={palette.text}>
          {` ${truncateEnd(right, 24)} `}
        </Text>
      </Box>
    </Box>
  );
}

function FooterDivider({ width }: { width: number }) {
  return (
    <Box flexShrink={0}>
      <Text color={palette.borderSoft}>{'─'.repeat(width)}</Text>
    </Box>
  );
}

export function HintLine({ children }: { children: React.ReactNode }) {
  return (
    <Box flexShrink={1}>
      <Text color={palette.dim} wrap="truncate-end">
        {children}
      </Text>
    </Box>
  );
}

export function BulletList({ items }: { items: string[] }) {
  return (
    <Box flexDirection="column">
      {items.map(item => (
        <Box key={item}>
          <Text color={palette.green}>✓ </Text>
          <Text color={palette.text}>{item}</Text>
        </Box>
      ))}
    </Box>
  );
}
