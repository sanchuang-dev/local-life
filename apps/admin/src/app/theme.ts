import type { ThemeConfig } from 'antd'

/**
 * Local Life admin theme.
 *
 * The palette is taken from the resident H5 (design.md §2): deep teal is the
 * brand action colour, white surfaces sit on a light gray-green page, and
 * borders stay hairline-thin. Benefit Hub's blue token set is deliberately not
 * copied — it is a different product brand.
 */
export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: '#116d63',
    // Info stays blue; Success is a distinct, readable green rather than
    // reusing brand teal. All status components consume this same palette.
    colorInfo: '#1677ff',
    colorLink: '#116d63',
    // Ant Design 6 generates a muddy gray-green colorSuccessBg for a dark
    // custom green (#187d4d). Pin the semantic surface scale centrally so
    // filled Tags, Alerts and other status components remain legible.
    // Warning/Error continue to use Ant Design's semantic defaults.
    colorSuccess: '#187d4d',
    colorSuccessBg: '#e9f8ee',
    colorSuccessBgHover: '#d5f0df',
    colorSuccessBorder: '#a6dcba',
    colorSuccessBorderHover: '#83c9a0',
    colorText: '#1f2937',
    colorTextSecondary: '#64748b',
    colorTextDescription: '#64748b',
    colorBgLayout: '#f5f7f7',
    colorBgContainer: '#ffffff',
    colorBorder: '#dfe7e3',
    colorBorderSecondary: '#e8f0ec',
    borderRadius: 6,
    controlHeight: 32,
    fontSize: 14,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      bodyBg: '#f5f7f7',
      siderBg: '#ffffff',
      headerHeight: 52,
      headerPadding: '0 16px',
    },
    Menu: {
      itemSelectedBg: '#e8f6f0',
      itemSelectedColor: '#116d63',
      itemHeight: 36,
      itemBorderRadius: 6,
    },
    Table: {
      headerBg: '#fafcfb',
      headerColor: '#475569',
      headerSplitColor: '#eef0f2',
      rowHoverBg: '#f3faf7',
      cellPaddingBlockMD: 10,
      cellPaddingInlineMD: 16,
    },
    Descriptions: { labelColor: '#64748b' },
    Segmented: { itemColor: '#64748b' },
    Tabs: { itemSelectedColor: '#116d63', itemHoverColor: '#138b79' },
  },
}
