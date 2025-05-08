# Fogo - Ambient交易机器人

Fogo是一个在Scroll网络上使用Ambient DEX执行自动交易的工具，专为DEX流动性和交易量优化设计。该工具通过智能合约交互，在USDC和USDT之间执行高效、随机化的交易策略。

## 🚀 功能特点

- **多钱包支持**: 同时管理多个钱包账户的交易活动
- **智能资金管理**: 自动将ETH兑换为USDC/USDT，保留配置的gas费
- **双向交易引擎**: USDC和USDT之间的智能双向循环交易
- **高级随机化策略**: 
  - 交易金额随机化
  - 交易时间间隔随机化
  - 交易方向偏好随机化
  - 钱包特定交易模式
- **交易优化**: 使用成功案例参数模板，提高交易成功率
- **完整日志记录**: 详细记录每笔交易和余额变化

## ⚙️ 安装步骤

1. 安装Node.js (推荐v16或更高版本)
2. 克隆本仓库
   ```bash
   git clone https://github.com/Zzzzzarvis/fogo.git
   cd fogo
   ```
3. 安装依赖
   ```bash
   npm install
   ```
4. 复制环境变量模板
   ```bash
   cp .env.example .env
   ```
5. 编辑`.env`文件配置您的参数

## 📝 配置

编辑`.env`文件自定义交易参数:

```
# 私钥列表（用逗号分隔）
PRIVATE_KEYS=0x123abc...,0x456def...

# 交易配置
TARGET_TOTAL_VOLUME_MIN=15000
TARGET_TOTAL_VOLUME_MAX=18000
SINGLE_SWAP_AMOUNT_MIN=15
SINGLE_SWAP_AMOUNT_MAX=35

# 时间间隔配置（秒）
TIME_INTERVAL_MIN=60
TIME_INTERVAL_MAX=300

# 保留ETH数量范围（用于支付gas费）
RESERVE_ETH_MIN=0.001
RESERVE_ETH_MAX=0.002

# Scroll网络RPC
RPC_URL=https://rpc.scroll.io/

# Ambient合约地址
CROC_SWAP_ROUTER=0xfB5f26851E03449A0403Ca945eBB4201415fd1fc
CROC_SWAP_DEX=0xaaaaAAAACB71BF2C8CaE522EA5fa455571A74106

# USDC和USDT在Scroll上的合约地址
USDC_ADDRESS=0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4
USDT_ADDRESS=0xf55bec9cafdbe8730f096aa55dad6d22d44099df 
```

## 🔍 高级配置说明

- **PRIVATE_KEYS**: 钱包私钥列表（请确保安全存储）
- **TARGET_TOTAL_VOLUME**: 每个钱包的目标交易总量范围（美元）
- **SINGLE_SWAP_AMOUNT**: 单次交易金额范围（美元）
- **TIME_INTERVAL**: 交易间隔时间范围（秒）
- **RESERVE_ETH**: 每个钱包保留的ETH数量范围
- **合约地址**: Ambient DEX和代币的合约地址（Scroll网络）

## 🚀 使用方法

```bash
# 使用npm脚本启动
npm start

# 或直接使用node运行
node swapBot.js
```

## 📊 工作原理

该工具采用多层随机化策略，确保交易模式具有高度不可预测性：

1. **初始化阶段**:
   - 连接到Scroll网络
   - 加载配置的钱包
   - 为每个钱包设置随机化的交易目标

2. **ETH转换阶段**:
   - 检查钱包ETH余额
   - 随机保留配置范围内的ETH作为gas费
   - 将剩余ETH兑换为USDC
   - 使用成功案例参数模板执行转换

3. **交易循环**:
   - 为每个钱包创建独特的交易方向偏好
   - 每笔交易随机化金额（范围内）
   - 根据钱包余额和偏好智能选择交易方向
   - 应用小幅随机波动使每笔交易独特
   - 随机化交易等待时间

4. **智能参数选择**:
   - 对不同交易方向使用专用参数组合
   - 基于成功交易案例的参数模板
   - 针对ETH→USDC、USDT→USDC和USDC→USDT的不同优化配置

## 🛠 技术详情

- **ETH到USDC转换**: 使用callpath=1和专用参数格式
- **稳定币互换**: 针对USDT→USDC和USDC→USDT的不同参数组合
- **第一笔交易处理**: 首次交易使用小额金额（1-3单位）以确保成功
- **交易参数随机化**: 在保持成功格式的同时添加随机元素
- **智能错误处理**: 自动重试机制和降级流程
- **资金使用优化**: 高效利用ETH，维持最小保留量

## ⚠️ 重要提示

- 此工具仅用于合法场景下的DEX交易量和流动性优化
- 交易参数已针对Scroll网络上的Ambient DEX优化
- 首次运行时建议使用小额资金测试
- 确保使用Scroll网络上足够的ETH支付gas费

## 🤝 贡献

欢迎提交Pull Request和Issue，请确保您的代码符合项目风格和目标。

## 📜 许可证

MIT

## 🔗 链接

- GitHub: [https://github.com/Zzzzzarvis/fogo](https://github.com/Zzzzzarvis/fogo)
- Scroll网络: [https://scroll.io](https://scroll.io)
- Ambient DEX: [https://ambient.finance](https://ambient.finance) 