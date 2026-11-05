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
    // Info keeps Ant Design's blue so Alert/Tag/Message feedback is clearly
    // distinct from Success; both background/border/text shades are derived
    // from these two tokens by the theme algorithm — no per-component CSS
    // overrides such as `.ant-alert-info` are allowed to re-skin them.
    colorInfo: '#1677ff',
    colorLink: '#116d63',
    // Success stays on the Local Life teal family so status feedback matches
    // the brand; Warning/Error keep Ant Design defaults (gold/red), which are
    // already unambiguous against Primary/Info/Success.
    colorSuccess: '#138b79',
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
