import type {
  SimulatedOrder,
  SimulatedProduct,
  SimulatedRefund,
} from './crmeb-simulated-server.js'

/**
 * SIMULATED fixtures shaped from the evidence document. They intentionally
 * include the awkward cases: decimal strings, an off-shelf product, an unpaid
 * order, a refunded order, an unknown status and an after-sale record.
 */

const BASE_TIME = 1_790_000_000

export const SIMULATED_PRODUCTS: SimulatedProduct[] = [
  {
    id: 101,
    image: '/uploads/products/101-main.png',
    slider_image: ['/uploads/products/101-a.png', 'https://cdn.example.com/101-b.png'],
    store_name: '有机蔬菜礼盒',
    store_info: '当季直采',
    price: '12.30',
    ot_price: '19.90',
    cate_id: '3,4',
    cate_name: '食品,生鲜',
    is_show: 1,
    spec_type: 1,
    description: '<p>基地直采</p>',
  },
  {
    id: 102,
    image: '/uploads/products/102-main.png',
    store_name: '已下架测试商品',
    store_info: '不应出现在居民端',
    price: '5.00',
    is_show: 0,
    spec_type: 0,
  },
  {
    id: 103,
    image: '',
    slider_image: [],
    store_name: '一分钱测试品',
    store_info: '金额精度测试',
    price: '0.30',
    ot_price: '0',
    cate_id: '3',
    cate_name: '食品',
    is_show: 1,
    spec_type: 0,
  },
]

export const SIMULATED_PRODUCT_DETAILS: Record<string, SimulatedProduct> = {
  '101': {
    ...SIMULATED_PRODUCTS[0]!,
    attrs: [
      {
        id: 501,
        unique: 'sku-501',
        price: '12.30',
        image: '/uploads/products/101-a.png',
        suk: '规格:小份',
        // CRMEB unsets stock in outapi; including it here proves the adapter
        // does not forward it.
        stock: 3,
      },
      {
        id: 502,
        unique: 'sku-502',
        price: '13.00',
        image: '',
        suk: '规格:大份',
      },
    ],
  },
  '102': {
    ...SIMULATED_PRODUCTS[1]!,
    attrs: [],
  },
}

/** List rows deliberately omit `refund_status` (CRMEB unsets it). */
export const SIMULATED_ORDER_LIST: SimulatedOrder[] = [
  {
    id: 9001,
    order_id: 'cp1001',
    uid: 5001,
    paid: 1,
    status: 3,
    pay_type: 'weixin',
    pay_time: BASE_TIME + 60,
    add_time: BASE_TIME,
    pay_price: '99.90',
    items: [
      {
        store_name: '有机蔬菜礼盒',
        suk: '规格:小份',
        image: '/uploads/products/101-a.png',
        price: '99.90',
        cart_num: 1,
      },
    ],
  },
  {
    id: 9002,
    order_id: 'cp1002',
    uid: 5002,
    paid: 1,
    status: 0,
    pay_type: 'weixin',
    pay_time: BASE_TIME + 120,
    add_time: BASE_TIME + 30,
    pay_price: '50.00',
  },
  {
    id: 9003,
    order_id: 'cp1003',
    uid: 5003,
    paid: 0,
    status: 0,
    pay_time: 0,
    add_time: BASE_TIME + 60,
    pay_price: '20.00',
  },
  {
    id: 9004,
    order_id: 'cp1004',
    uid: 5004,
    paid: 1,
    status: 3,
    pay_type: 'weixin',
    pay_time: BASE_TIME + 180,
    add_time: BASE_TIME + 90,
    pay_price: '60.00',
  },
  {
    id: 9005,
    order_id: 'cp1005',
    uid: 5005,
    paid: 1,
    status: 9,
    pay_type: 'weixin',
    pay_time: BASE_TIME + 240,
    add_time: BASE_TIME + 120,
    pay_price: '10.00',
  },
]

export const SIMULATED_ORDER_DETAILS: Record<string, SimulatedOrder> = {
  cp1001: { ...SIMULATED_ORDER_LIST[0]!, refund_status: 0 },
  cp1002: { ...SIMULATED_ORDER_LIST[1]!, refund_status: 2 },
  cp1003: { ...SIMULATED_ORDER_LIST[2]!, refund_status: 0 },
  cp1004: { ...SIMULATED_ORDER_LIST[3]!, refund_status: 0 },
  cp1005: { ...SIMULATED_ORDER_LIST[4]!, refund_status: 0 },
}

export const SIMULATED_REFUNDS: SimulatedRefund[] = [
  {
    id: 7001,
    store_order_id: 9004,
    order_id: 'rf2001',
    refund_type: 6,
    refund_price: '60.00',
    refunded_price: '60.00',
    refunded_time: BASE_TIME + 300,
    add_time: BASE_TIME + 200,
  },
]
