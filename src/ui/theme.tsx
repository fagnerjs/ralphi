import { defaultTheme, extendTheme } from '@inkjs/ui';
import type { TextProps } from 'ink';

export const palette = {
  bg: '#08080d',
  panel: '#12121a',
  panelAlt: '#171721',
  border: '#7c4dff',
  borderSoft: '#50318f',
  accent: '#ff5ea9',
  accentSoft: '#c06cff',
  cyan: '#7de2ff',
  green: '#7ef7b8',
  yellow: '#f9f871',
  text: '#f4ecff',
  dim: '#8a86a5',
  muted: '#6f6a87',
  danger: '#ff7aa2'
} as const;

export const systemTheme = extendTheme(defaultTheme, {
  components: {
    Spinner: {
      styles: {
        frame: (): TextProps => ({
          color: palette.accent
        }),
        label: (): TextProps => ({
          color: palette.text
        })
      }
    },
    ProgressBar: {
      styles: {
        completed: (): TextProps => ({
          color: palette.accent
        }),
        remaining: (): TextProps => ({
          color: palette.borderSoft
        })
      }
    },
    Badge: {
      styles: {
        text: ({ color }): TextProps => ({
          color:
            color === 'green'
              ? palette.green
              : color === 'yellow'
                ? palette.yellow
                : color === 'red'
                  ? palette.danger
                  : palette.cyan
        })
      }
    }
  }
});
