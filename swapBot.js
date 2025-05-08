// 在文件最顶部添加明显的调试日志
console.log("========== 脚本开始加载 ==========");

// 导入必要的库
const ethers = require('ethers');
const dotenv = require('dotenv');
const chalk = require('chalk');
const fs = require('fs');

// 加载环境变量
dotenv.config();

// 日志文件
const LOG_FILE = './swap_bot_logs.txt';

// ERC20 ABI - 只包含我们需要的函数
const ERC20_ABI = [
    // 查询余额
    "function balanceOf(address owner) view returns (uint256)",
    // 查询授权额度
    "function allowance(address owner, address spender) view returns (uint256)",
    // 授权
    "function approve(address spender, uint256 amount) returns (bool)",
    // 转账
    "function transfer(address to, uint256 amount) returns (bool)",
    // 代币名称与符号
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
];

// 路由合约 ABI
const ROUTER_ABI = [
    // swap 函数
    "function swap(address base, address quote, uint256 poolIdx, bool isBuy, bool inBaseQty, uint128 qty, uint16 tip, uint128 limitPrice, uint128 minOut, uint8 reserveFlags) payable returns (int128 baseFlow, int128 quoteFlow)"
];

// DEX合约 ABI
const DEX_ABI = [
    // userCmd 函数，这是我们真正需要使用的
    "function userCmd(uint16 callpath, bytes calldata) payable returns (bytes)"
];

// 全局变量
let provider;
let wallets = [];
let totalVolumeByWallet = {};
let targetVolumeByWallet = {};

// 记录日志
function log(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(isError ? chalk.red(logMessage) : chalk.green(logMessage));
    fs.appendFileSync(LOG_FILE, `${logMessage}\n`);
}

// 随机数生成器 - 在指定范围内生成随机数
function getRandomNumber(min, max) {
    return Math.random() * (max - min) + min;
}

// 等待指定时间（毫秒）
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 初始化钱包和合约
async function initialize() {
    console.log("========== 开始初始化 ==========");
    try {
        // 连接到网络
        provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
        const network = await provider.getNetwork();
        log(`已连接到网络: ${network.name} (ChainID: ${network.chainId})`);

        // 加载私钥 - 确保去除前缀0x，ethers不需要它
        const privateKeys = process.env.PRIVATE_KEYS.split(',').map(key => key.startsWith('0x') ? key.substring(2) : key);
        log(`加载了 ${privateKeys.length} 个钱包`);

        // 创建钱包实例
        for (const privateKey of privateKeys) {
            const wallet = new ethers.Wallet(privateKey, provider);
            wallets.push(wallet);

            // 设置每个钱包的目标交易量
            const targetVolume = getRandomNumber(
                parseFloat(process.env.TARGET_TOTAL_VOLUME_MIN), 
                parseFloat(process.env.TARGET_TOTAL_VOLUME_MAX)
            );

            targetVolumeByWallet[wallet.address] = targetVolume;
            totalVolumeByWallet[wallet.address] = 0;

            log(`钱包 ${wallet.address} 目标交易量: $${targetVolume.toFixed(2)}`);
        }

        console.log(`加载了 ${process.env.PRIVATE_KEYS.split(',').length} 个钱包`);
        console.log(`RPC URL: ${process.env.RPC_URL}`);
    } catch (error) {
        console.error("初始化过程出错:", error);
        throw error;
    }
    console.log("========== 初始化完成 ==========");
}

// 查询余额
async function checkBalances(wallet) {
    const usdcContract = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, wallet);
    const usdtContract = new ethers.Contract(process.env.USDT_ADDRESS, ERC20_ABI, wallet);
    
    // 获取代币精度
    const usdcDecimals = await usdcContract.decimals();
    const usdtDecimals = await usdtContract.decimals();
    
    // 获取余额
    const ethBalance = await wallet.getBalance();
    const usdcBalance = await usdcContract.balanceOf(wallet.address);
    const usdtBalance = await usdtContract.balanceOf(wallet.address);
    
    // 格式化余额显示
    const ethBalanceFormatted = ethers.utils.formatEther(ethBalance);
    const usdcBalanceFormatted = ethers.utils.formatUnits(usdcBalance, usdcDecimals);
    const usdtBalanceFormatted = ethers.utils.formatUnits(usdtBalance, usdtDecimals);
    
    return {
        eth: parseFloat(ethBalanceFormatted),
        usdc: parseFloat(usdcBalanceFormatted),
        usdt: parseFloat(usdtBalanceFormatted),
        ethRaw: ethBalance,
        usdcRaw: usdcBalance,
        usdtRaw: usdtBalance,
        usdcDecimals: usdcDecimals,
        usdtDecimals: usdtDecimals
    };
}

// 授权代币
async function approveToken(wallet, tokenAddress, spenderAddress) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const tokenSymbol = await tokenContract.symbol();
        const allowance = await tokenContract.allowance(wallet.address, spenderAddress);
        
        // 如果授权额度不足，则进行授权
        if (allowance.lt(ethers.constants.MaxUint256.div(2))) {
            log(`为钱包 ${wallet.address} 授权 ${tokenSymbol} 代币...`);
            
            const tx = await tokenContract.approve(
                spenderAddress,
                ethers.constants.MaxUint256
            );
            
            await tx.wait();
            log(`${tokenSymbol} 授权成功，交易哈希: ${tx.hash}`);
            return true;
        } else {
            log(`${tokenSymbol} 已有足够授权`);
            return true;
        }
    } catch (error) {
        log(`授权失败: ${error.message}`, true);
        return false;
    }
}

// ETH到USDC兑换函数 - 基于成功交易案例优化
async function swapEthToStablecoin(wallet, tokenAddress) {
    try {
        // 检查当前ETH余额
        const balances = await checkBalances(wallet);
        
        // 严格按照.env配置的范围保留ETH
        const minReserve = parseFloat(process.env.RESERVE_ETH_MIN);
        const maxReserve = parseFloat(process.env.RESERVE_ETH_MAX);
        const reserveEth = minReserve + Math.random() * (maxReserve - minReserve);
        
        // 取三位小数并记录为单独变量以便日志记录
        const reserveEthRounded = Math.floor(reserveEth * 1000) / 1000;
        
        // 计算可用于交换的ETH
        let ethToSwap = balances.eth - reserveEthRounded;
        
        // 确保我们有足够的ETH可交换
        if (ethToSwap <= 0.0005) {
            log(`ETH余额不足以执行兑换，当前余额: ${balances.eth.toFixed(6)} ETH，需要保留: ${reserveEthRounded.toFixed(6)} ETH`, true);
            return false;
        }
        
        // 为安全起见，减少5%，确保有足够的gas费
        ethToSwap = ethToSwap * 0.95;
        
        // 确保金额有4位小数以避免精度问题
        ethToSwap = Math.floor(ethToSwap * 10000) / 10000;
        
        log(`准备将 ${ethToSwap.toFixed(6)} ETH 兑换为 USDC，保留 ${reserveEthRounded.toFixed(6)} ETH 作为gas费 (范围: ${minReserve.toFixed(6)}-${maxReserve.toFixed(6)})`);
        
        // 使用DEX合约
        const dexContract = new ethers.Contract(process.env.CROC_SWAP_DEX, DEX_ABI, wallet);
        
        // 准备交易数据 - 完全匹配成功案例格式
        const callpath = 1;
        
        // 将ETH数量转换为Wei
        const ethToSwapWei = ethers.utils.parseEther(ethToSwap.toString());
        
        // 使用成功案例中的bytecode结构
        // 参考Input Data中的格式，构建一个完全匹配的raw_bytes结构
        const raw_bytes = ethers.utils.defaultAbiCoder.encode(
            [
                'address', // 这里与成功案例匹配，[3]位置应该是ETH地址的占位符
                'address', // USDC地址
                'uint',    // poolIdx
                'bool',    // isBuy
                'bool',    // inBaseQty
                'uint128', // qty (ETH数量)
                'uint16',  // tip
                'uint128', // limitPrice 
                'uint128', // minOut
                'uint8'    // settleFlags
            ],
            [
                ethers.constants.AddressZero, // 使用零地址表示ETH，与成功案例匹配[3]位置
                process.env.USDC_ADDRESS,     // USDC地址，对应成功案例[4]位置
                420,                          // poolIdx，对应成功案例[5]位置 (0x1a4 = 420)
                true,                         // isBuy，对应成功案例[6]位置
                true,                         // inBaseQty，对应成功案例[7]位置
                ethToSwapWei,                 // qty，对应成功案例[8]位置
                0,                            // tip，对应成功案例[9]位置
                "0x000000000ffff5433e2b3d8211706e6102aa9471", // limitPrice，对应成功案例[10]位置
                "0x9371bd",                   // minOut，对应成功案例[11]位置
                0                            // settleFlags，对应成功案例[12]位置
            ]
        );
        
        // 使用与成功案例相似的gas价格 - 使用较低的gas价格
        const gasPrice = ethers.utils.parseUnits('0.04', 'gwei'); // 使用接近成功案例的值
        
        // 使用Legacy交易类型，匹配成功案例
        const txOptions = {
            gasLimit: 400000,          // 足够大的gas限制，但不过大
            gasPrice: gasPrice,        // 使用固定较低的gas价格
            type: 0,                   // Legacy交易类型，与成功案例一致
            value: ethToSwapWei        // 发送的ETH数量
        };
        
        log(`发送ETH兑换交易，使用精确匹配成功案例的参数格式...`);
        
        // 发送交易
        const tx = await dexContract.userCmd(
            callpath,
            raw_bytes,
            txOptions
        );
        
        const txHashShort = tx.hash.substring(0, 40) + "...";
        log(`ETH兑换交易已提交，等待确认，交易哈希: ${txHashShort}`);
        
        // 等待交易确认
        const receipt = await tx.wait();
        
        if (receipt && receipt.status === 1) {
            log(`成功将 ${ethToSwap.toFixed(6)} ETH 兑换为 USDC，交易哈希: ${txHashShort}`);
            return true;
        } else {
            log(`交易已确认但状态未成功`, true);
            return false;
        }
    } catch (error) {
        let errorMsg = error.message || "未知错误";
        log(`ETH兑换USDC失败: ${errorMsg.substring(0, 150)}...`, true);
        
        // 如果失败，尝试使用更小的金额和更简单的参数
        if (errorMsg.includes("transaction failed") || 
            errorMsg.includes("execution reverted") ||
            errorMsg.includes("value out-of-bounds")) {
            
            log(`尝试使用更简单的参数重试...`);
            try {
                return await swapEthToUSDCSimplified(wallet, tokenAddress);
            } catch (altError) {
                log(`简化方案也失败: ${altError.message.substring(0, 150)}...`, true);
                return false;
            }
        }
        
        return false;
    }
}

// 简化版ETH到USDC兑换函数 - 使用更简单的参数
async function swapEthToUSDCSimplified(wallet, tokenAddress) {
    // 检查当前ETH余额
    const balances = await checkBalances(wallet);
    
    // 同样按照.env配置范围随机保留ETH
    const minReserve = parseFloat(process.env.RESERVE_ETH_MIN);
    const maxReserve = parseFloat(process.env.RESERVE_ETH_MAX);
    const reserveEth = minReserve + Math.random() * (maxReserve - minReserve);
    const reserveEthRounded = Math.floor(reserveEth * 1000) / 1000;
    
    let ethToSwap = balances.eth - reserveEthRounded;
    
    if (ethToSwap <= 0.001) {
        log(`ETH余额不足以执行简化版兑换，当前余额: ${balances.eth.toFixed(6)} ETH，保留: ${reserveEthRounded.toFixed(6)} ETH`, true);
        return false;
    }
    
    // 为安全起见，减少交易金额10%
    ethToSwap = ethToSwap * 0.9; 
    ethToSwap = Math.floor(ethToSwap * 10000) / 10000;
    
    log(`使用简化方案，尝试兑换 ${ethToSwap.toFixed(6)} ETH 到 USDC，保留 ${reserveEthRounded.toFixed(6)} ETH (范围: ${minReserve.toFixed(6)}-${maxReserve.toFixed(6)})`);
    
    // 使用DEX合约
    const dexContract = new ethers.Contract(process.env.CROC_SWAP_DEX, DEX_ABI, wallet);
    
    // 准备交易数据
    const callpath = 1;
    
    // 将ETH数量转换为Wei
    const ethToSwapWei = ethers.utils.parseEther(ethToSwap.toString());
    
    // 使用更简单的编码，参考真实案例的结构
    const raw_bytes = ethers.utils.defaultAbiCoder.encode(
        [
            'bytes' // 使用单一字节数组，让合约自行解析
        ],
        [
            // 简化参数，但保持关键字段不变
            ethers.utils.solidityPack(
                ['address', 'address', 'uint256', 'bool', 'bool', 'uint256', 'uint256', 'uint256', 'uint256', 'uint8'],
                [
                    ethers.constants.AddressZero, // ETH地址为零地址
                    process.env.USDC_ADDRESS,     // USDC地址
                    420,                          // poolIdx
                    true,                         // isBuy
                    true,                         // inBaseQty
                    ethToSwapWei,                 // qty
                    0,                           // tip
                    0,                           // 简化limitPrice
                    0,                           // 简化minOut
                    0                            // settleFlags
                ]
            )
        ]
    );
    
    // 使用超低gas价格，匹配链上成功案例
    const txOptions = {
        gasLimit: 800000,          // 使用更大的gas限制以确保执行
        gasPrice: ethers.utils.parseUnits('0.02', 'gwei'), // 更低的gas价格
        type: 0,                   // Legacy交易类型
        value: ethToSwapWei        // 发送的ETH数量
    };
    
    // 发送交易
    const tx = await dexContract.userCmd(
        callpath,
        raw_bytes,
        txOptions
    );
    
    log(`简化ETH兑换交易已提交，交易哈希: ${tx.hash.substring(0, 40)}...`);
    
    const receipt = await tx.wait();
    
    if (receipt && receipt.status === 1) {
        log(`简化方案成功将 ${ethToSwap.toFixed(6)} ETH 兑换为 USDC`);
        return true;
    } else {
        log(`简化方案交易状态未成功`, true);
        return false;
    }
}

// 备用ETH到USDC兑换函数 - 使用更简化的参数
async function swapEthToUSDCAlternative(wallet, tokenAddress, existingBalances) {
    // 使用现有余额或重新检查
    const balances = existingBalances || await checkBalances(wallet);
    
    // 同样按照.env配置范围随机保留ETH
    const minReserve = parseFloat(process.env.RESERVE_ETH_MIN);
    const maxReserve = parseFloat(process.env.RESERVE_ETH_MAX);
    const reserveEth = minReserve + Math.random() * (maxReserve - minReserve);
    const reserveEthRounded = Math.floor(reserveEth * 1000) / 1000;
    
    let ethToSwap = balances.eth - reserveEthRounded;
    
    if (ethToSwap <= 0.0005) {
        log(`ETH余额不足以执行备用兑换方案，当前余额: ${balances.eth.toFixed(6)} ETH，保留: ${reserveEthRounded.toFixed(6)} ETH`, true);
        return false;
    }
    
    // 减少兑换量以确保成功
    ethToSwap = ethToSwap * 0.9;
    ethToSwap = Math.floor(ethToSwap * 10000) / 10000;
    
    log(`使用备用方案尝试将 ${ethToSwap.toFixed(6)} ETH 兑换为 USDC，保留 ${reserveEthRounded.toFixed(6)} ETH (范围: ${minReserve.toFixed(6)}-${maxReserve.toFixed(6)})`);
    
    // 使用DEX合约
    const dexContract = new ethers.Contract(process.env.CROC_SWAP_DEX, DEX_ABI, wallet);
    
    // 使用最简化的参数，完全匹配成功案例
    const callpath = 1;
    
    // 参考成功案例数据结构，使用简化编码
    const raw_bytes = ethers.utils.defaultAbiCoder.encode(
        ['address', 'uint', 'bool', 'bool', 'uint256', 'uint16', 'uint', 'uint', 'uint8'],
        [
            process.env.USDC_ADDRESS, // 目标代币地址
            420, // poolIdx
            true, // isBuy
            true, // inBaseQty
            ethers.utils.parseEther(ethToSwap.toString()), // 金额
            0, // tip
            0, // 简化的limitPrice
            0, // 简化的minOut
            0 // settleFlags
        ]
    );
    
    // 使用Legacy交易类型
    const txOptions = {
        gasLimit: 600000,
        gasPrice: ethers.utils.parseUnits('0.04', 'gwei'),
        type: 0,
        value: ethers.utils.parseEther(ethToSwap.toString())
    };
    
    // 发送交易
    const tx = await dexContract.userCmd(
        callpath,
        raw_bytes,
        txOptions
    );
    
    log(`备用ETH兑换交易已提交，交易哈希: ${tx.hash.substring(0, 40)}...`);
    
    const receipt = await tx.wait();
    
    if (receipt && receipt.status === 1) {
        log(`备用方案成功将ETH兑换为USDC`);
        return true;
    } else {
        log(`备用方案交易状态未成功`, true);
        return false;
    }
}

// 正确的USDT到USDC交易函数(原来的名称与功能不符)
async function rawSwapUSDTtoUSDC(wallet, amount) {
    try {
        // 验证余额是否充足
        const balances = await checkBalances(wallet);
        
        // 检查ETH余额是否足够支付gas费
        if (balances.eth < 0.0005) {
            log(`钱包 ${wallet.address} ETH余额不足以支付gas费，当前ETH: ${balances.eth.toFixed(6)}`, true);
            return false;
        }
        
        if (balances.usdt < amount) {
            log(`钱包 ${wallet.address} USDT余额不足，需要${amount}，实际${balances.usdt.toFixed(2)}`, true);
            return false;
        }
        
        // 使用传入的金额并添加小的随机波动（±5%）以增加随机性
        const randomFactor = 0.95 + (Math.random() * 0.1); // 0.95-1.05之间的随机数
        const safeAmount = Math.floor(amount * randomFactor * 100) / 100; // 保留两位小数
        
        log(`钱包 ${wallet.address} 尝试将 ${safeAmount.toFixed(2)} USDT 换成 USDC...`);
        
        // 使用DEX合约
        const dexContract = new ethers.Contract(process.env.CROC_SWAP_DEX, DEX_ABI, wallet);
        
        // 获取USDT精度
        const usdtContract = new ethers.Contract(process.env.USDT_ADDRESS, ERC20_ABI, wallet);
        const usdtDecimals = await usdtContract.decimals();
        
        // 计算金额的Wei值
        const amountInWei = ethers.utils.parseUnits(safeAmount.toString(), usdtDecimals);
        
        // 准备交易数据
        const callpath = 1;
        
        // 随机选择limitPrice的值，在65537到66000之间
        const randomLimitPrice = 65537 + Math.floor(Math.random() * 463);
        
        // 构建原始字节数据 - 使用已知的成功配置但增加随机元素
        const raw_bytes = ethers.utils.defaultAbiCoder.encode(
            ['address', 'address', 'uint', 'bool', 'bool', 'uint128', 'uint16', 'uint128', 'uint128', 'uint8'],
            [
                process.env.USDC_ADDRESS,
                process.env.USDT_ADDRESS,
                420,
                false, // isBuy = false
                false, // inBaseQty = false
                amountInWei.toString(),
                0,
                randomLimitPrice, // 随机化limitPrice
                0, // minOut
                0
            ]
        );
        
        // 随机调整gas价格（在0.05-0.15 gwei之间）以增加随机性
        const randomGasPrice = 0.05 + (Math.random() * 0.1);
        
        // 使用Legacy交易类型，但随机化gas配置
        const txOptions = {
            gasLimit: 500000 + Math.floor(Math.random() * 200000), // 500000-700000随机gas限制
            gasPrice: ethers.utils.parseUnits(randomGasPrice.toFixed(4), 'gwei'),
            type: 0 // Legacy交易
        };
        
        // 发送交易
        const tx = await dexContract.userCmd(
            callpath,
            raw_bytes,
            txOptions
        );
        
        const txHashShort = tx.hash.substring(0, 40) + "..."; 
        log(`交易已提交，等待确认，交易哈希: ${txHashShort}`);
        
        // 等待交易确认
        const receipt = await tx.wait();
        
        if (receipt && receipt.status === 1) {
            // 记录交易量
            totalVolumeByWallet[wallet.address] += safeAmount;
            
            log(`USDT兑换USDC成功，交易哈希: ${txHashShort}`);
            log(`钱包 ${wallet.address} 当前累计交易量: $${totalVolumeByWallet[wallet.address].toFixed(2)}，目标: $${targetVolumeByWallet[wallet.address].toFixed(2)}`);
            
            return true;
        } else {
            log(`交易被确认但状态未成功`, true);
            return false;
        }
    } catch (error) {
        let errorMsg = error.message || "未知错误";
        log(`USDT兑换USDC失败: ${errorMsg.substring(0, 150)}...`, true);
        
        // 如果是ETH不足，则不再重试
        if (errorMsg.includes("insufficient funds")) {
            log(`ETH余额不足以支付交易费用，请充值ETH后再试`, true);
            return false;
        }
        
        // 如果参数错误，尝试减少金额并降低gas费用
        if (amount > 2 && (errorMsg.includes("execution reverted") || errorMsg.includes("gas required"))) {
            const reducedAmount = amount * 0.5;
            log(`尝试减少金额重试: ${reducedAmount.toFixed(2)} USDT`);
            await sleep(3000);
            return await rawSwapUSDTtoUSDC(wallet, reducedAmount);
        }
        
        return false;
    }
}

// USDC到USDT交易函数 - 也添加类似的随机因素
async function rawSwapUSDCtoUSDT(wallet, amount) {
    try {
        // 验证余额是否充足
        const balances = await checkBalances(wallet);
        
        // 检查ETH余额是否足够支付gas费
        if (balances.eth < 0.0005) {
            log(`钱包 ${wallet.address} ETH余额不足以支付gas费，当前ETH: ${balances.eth.toFixed(6)}`, true);
            return false;
        }
        
        if (balances.usdc < amount) {
            log(`钱包 ${wallet.address} USDC余额不足，需要${amount}，实际${balances.usdc.toFixed(2)}`, true);
            return false;
        }
        
        // 应用随机波动到金额（±5%）
        const randomFactor = 0.95 + (Math.random() * 0.1); // 0.95-1.05之间的随机数
        const safeAmount = Math.floor(amount * randomFactor * 100) / 100;
        log(`钱包 ${wallet.address} 将 ${safeAmount.toFixed(2)} USDC 换成 USDT (使用成功案例参数)...`);
        
        // 使用DEX合约
        const dexContract = new ethers.Contract(process.env.CROC_SWAP_DEX, DEX_ABI, wallet);
        
        // 获取USDC精度
        const usdcContract = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, wallet);
        const usdcDecimals = await usdcContract.decimals();
        
        // 计算金额的Wei值
        const amountInWei = ethers.utils.parseUnits(safeAmount.toString(), usdcDecimals);
        
        // 准备交易数据
        const callpath = 1;
        
        // 构建原始字节数据 - 完全匹配成功案例的参数组合
        const raw_bytes = ethers.utils.defaultAbiCoder.encode(
            ['address', 'address', 'uint', 'bool', 'bool', 'uint128', 'uint16', 'uint128', 'uint128', 'uint8'],
            [
                process.env.USDC_ADDRESS, // base token (USDC)
                process.env.USDT_ADDRESS, // quote token (USDT)
                420, // poolIdx
                true, // isBuy - 匹配成功案例
                true, // inBaseQty - 匹配成功案例
                amountInWei.toString(), // amount
                0, // tip
                '0x000000000ffff5433e2b3d8211706e6102aa9471', // limitPrice - 使用成功案例中的值
                0, // minOut
                0 // settleFlags
            ]
        );
        
        // 随机调整maxFeePerGas和maxPriorityFeePerGas
        const randomMaxFee = 0.8 + (Math.random() * 0.4); // 0.8-1.2 gwei
        const randomPriorityFee = 0.4 + (Math.random() * 0.2); // 0.4-0.6 gwei
        
        // 使用EIP-1559交易类型但增加随机gas配置
        const txOptions = {
            gasLimit: ethers.utils.hexlify(400000 + Math.floor(Math.random() * 200000)), // 400000-600000随机gas限制
            maxFeePerGas: ethers.utils.parseUnits(randomMaxFee.toFixed(4), 'gwei'),
            maxPriorityFeePerGas: ethers.utils.parseUnits(randomPriorityFee.toFixed(4), 'gwei')
        };
        
        // 发送交易
        const tx = await dexContract.userCmd(
            callpath,
            raw_bytes,
            txOptions
        );
        
        const txHashShort = tx.hash.substring(0, 40) + "..."; 
        log(`交易已提交，等待确认，交易哈希: ${txHashShort}`);
        
        // 等待交易确认
        const receipt = await tx.wait();
        
        if (receipt && receipt.status === 1) {
            // 记录交易量
            totalVolumeByWallet[wallet.address] += safeAmount;
            
            log(`USDC兑换USDT成功，交易哈希: ${txHashShort}`);
            log(`钱包 ${wallet.address} 当前累计交易量: $${totalVolumeByWallet[wallet.address].toFixed(2)}，目标: $${targetVolumeByWallet[wallet.address].toFixed(2)}`);
            
            return true;
        } else {
            log(`交易被确认但状态未成功`, true);
            return false;
        }
    } catch (error) {
        let errorMsg = error.message || "未知错误";
        log(`USDC兑换USDT失败: ${errorMsg.substring(0, 150)}...`, true);
        
        // 如果是ETH不足，则不再重试
        if (errorMsg.includes("insufficient funds")) {
            log(`ETH余额不足以支付交易费用，请充值ETH后再试`, true);
            return false;
        }
        
        // 如果参数错误，尝试减少金额并降低gas费用
        if (amount > 2 && (errorMsg.includes("execution reverted") || errorMsg.includes("gas required"))) {
            const reducedAmount = amount * 0.5;
            log(`尝试减少金额重试: ${reducedAmount.toFixed(2)} USDC`);
            await sleep(3000);
            return await rawSwapUSDCtoUSDT(wallet, reducedAmount);
        }
        
        return false;
    }
}

// 钱包执行循环函数
async function walletLoop(wallet) {
    try {
        // 检查初始余额
        const balances = await checkBalances(wallet);
        log(`钱包 ${wallet.address} 初始余额: ${balances.eth.toFixed(6)} ETH, ${balances.usdc.toFixed(2)} USDC, ${balances.usdt.toFixed(2)} USDT`);
        
        // 检查ETH余额是否足够运行脚本 - 由于Scroll是L2，所需的ETH更少
        if (balances.eth < 0.0005) {
            log(`钱包 ${wallet.address} ETH余额不足以支付gas费用，请充值ETH后再试`, true);
            return;
        }
        
        // 设置目标交易量，增加随机波动（±10%）
        let targetVolume = targetVolumeByWallet[wallet.address];
        const volumeRandomFactor = 0.9 + (Math.random() * 0.2); // 0.9-1.1之间的随机数
        targetVolume = targetVolume * volumeRandomFactor;
        log(`钱包 ${wallet.address} 随机调整后的目标交易量: $${targetVolume.toFixed(2)}`);
        
        totalVolumeByWallet[wallet.address] = 0;
        
        // 如果ETH余额充足但稳定币不足，则先兑换部分ETH为稳定币
        if (balances.eth > 0.003 && balances.usdc < 5 && balances.usdt < 5) {
            log(`钱包初始状态只有ETH，将大部分ETH兑换为USDC用于后续交易`);
            
            // 首先授权路由合约
            await approveToken(wallet, process.env.USDC_ADDRESS, process.env.CROC_SWAP_DEX);
            await approveToken(wallet, process.env.USDT_ADDRESS, process.env.CROC_SWAP_DEX);
            
            // 将ETH兑换成USDC
            await swapEthToStablecoin(wallet, process.env.USDC_ADDRESS);
            
            // 等待一个随机时间
            const waitTime = getRandomNumber(5000, 10000); // 5-10秒
            await sleep(waitTime);
            
            // 更新余额
            const newBalances = await checkBalances(wallet);
            log(`钱包 ${wallet.address} 更新余额: ${newBalances.eth.toFixed(6)} ETH, ${newBalances.usdc.toFixed(2)} USDC, ${newBalances.usdt.toFixed(2)} USDT`);
        }
        
        // 创建交易方向偏好 - 每个钱包可能有不同的偏好
        // 随机生成0.3-0.7之间的偏好系数，决定USDC->USDT和USDT->USDC的概率分布
        const directionPreference = 0.3 + (Math.random() * 0.4);
        log(`钱包 ${wallet.address} 随机交易方向偏好系数: ${directionPreference.toFixed(2)}`);
        
        // 开始执行交易循环
        while (totalVolumeByWallet[wallet.address] < targetVolume) {
            // 再次检查当前余额
            const currentBalances = await checkBalances(wallet);
            
            // 检查ETH余额，如果不足则退出循环
            if (currentBalances.eth < 0.0005) {
                log(`钱包 ${wallet.address} ETH余额不足，无法继续交易`, true);
                break;
            }
            
            // 确保授权
            await approveToken(wallet, process.env.USDC_ADDRESS, process.env.CROC_SWAP_DEX);
            await approveToken(wallet, process.env.USDT_ADDRESS, process.env.CROC_SWAP_DEX);
            
            // 使用直接交换函数替代原来的交换方式
            let swapSuccess = false;
            
            // 随机交换金额 - 从环境变量中获取范围
            let swapAmount = getRandomNumber(
                parseFloat(process.env.SINGLE_SWAP_AMOUNT_MIN),
                parseFloat(process.env.SINGLE_SWAP_AMOUNT_MAX)
            );
            
            // 截断到2位小数
            swapAmount = Math.floor(swapAmount * 100) / 100;
            
            // 从小金额开始，避免第一次交易就失败，但也增加随机性
            if(totalVolumeByWallet[wallet.address] === 0) {
                swapAmount = Math.min(swapAmount, getRandomNumber(1, 3)); // 第一次交易金额在1到3之间随机
            }
            
            // 决定本次交易方向 (USDC->USDT 或 USDT->USDC)
            // 使用钱包特定的偏好系数和余额情况来做决策
            const randomValue = Math.random();
            const usdcToUsdtCondition = currentBalances.usdc >= swapAmount && (
                (currentBalances.usdc > currentBalances.usdt * 1.2) || // USDC显著多于USDT
                (randomValue < directionPreference) // 或者随机值小于偏好系数
            );
            
            if (usdcToUsdtCondition) {
                // USDC -> USDT
                log(`选择交易方向: USDC → USDT (USDC余额: ${currentBalances.usdc.toFixed(2)}, 随机值: ${randomValue.toFixed(2)})`);
                swapSuccess = await rawSwapUSDCtoUSDT(wallet, swapAmount);
            } else if (currentBalances.usdt >= swapAmount) {
                // USDT -> USDC
                log(`选择交易方向: USDT → USDC (USDT余额: ${currentBalances.usdt.toFixed(2)}, 随机值: ${randomValue.toFixed(2)})`);
                swapSuccess = await rawSwapUSDTtoUSDC(wallet, swapAmount);
            } else {
                // 如果两种稳定币余额都不足，检查是否能兑换更多
                // 降低ETH阈值到0.001，Scroll L2链上gas费用很低，0.001ETH足够多次交易
                if (currentBalances.eth > 0.001) {
                    log(`稳定币余额不足，尝试将ETH换成USDC (ETH余额: ${currentBalances.eth.toFixed(4)})`);
                    await swapEthToStablecoin(wallet, process.env.USDC_ADDRESS);
                    await sleep(getRandomNumber(3000, 7000)); // 3-7秒
                    continue;
                } else {
                    // 检查是否有任何可用的代币余额，如果还有就继续交易
                    if (currentBalances.usdc >= 0.1 || currentBalances.usdt >= 0.1) {
                        log(`ETH不足以兑换更多，但仍有稳定币可交易。尝试使用现有余额继续。`);
                        continue;
                    }
                    
                    log(`钱包 ${wallet.address} 所有余额不足: ETH=${currentBalances.eth.toFixed(4)}, USDC=${currentBalances.usdc.toFixed(2)}, USDT=${currentBalances.usdt.toFixed(2)}`, true);
                    break;
                }
            }
            
            // 如果交易失败且原因是ETH不足，退出循环
            if (!swapSuccess && currentBalances.eth < 0.0005) {
                log(`由于ETH余额不足，停止交易循环`, true);
                break;
            }
            
            // 随机等待一段时间再执行下一次交易 - 使用环境变量中的范围
            const waitTimeSec = getRandomNumber(
                parseFloat(process.env.TIME_INTERVAL_MIN),
                parseFloat(process.env.TIME_INTERVAL_MAX)
            );
            
            log(`等待 ${waitTimeSec.toFixed(0)} 秒后进行下一次交易...`);
            await sleep(waitTimeSec * 1000); // 转换为毫秒
        }
        
        log(`钱包 ${wallet.address} 已完成交易目标，总交易量: $${totalVolumeByWallet[wallet.address].toFixed(2)}`);
    } catch (error) {
        log(`钱包 ${wallet.address} 执行出错: ${error.message}`, true);
    }
}

// 主函数
async function main() {
    console.log("========== 主函数开始执行 ==========");
    try {
        log(`=== Ambient Scroll网络刷交易脚本启动 ===`);
        
        // 初始化
        console.log("准备调用initialize()...");
        await initialize();
        console.log("initialize()调用完成");
        
        // 为每个钱包创建独立的循环
        console.log("准备启动钱包循环...");
        const walletPromises = wallets.map(wallet => walletLoop(wallet));
        
        // 等待所有钱包完成
        console.log("等待所有钱包交易完成...");
        await Promise.all(walletPromises);
        
        log(`=== 所有钱包交易任务完成 ===`);
    } catch (error) {
        console.error("主函数执行出错:", error);
        log(`程序执行出错: ${error.message}`, true);
    }
}

// 启动脚本
console.log("========== 脚本准备启动main()函数 ==========");
main().catch(error => {
    console.error("致命错误:", error);
    log(`致命错误: ${error.message}`, true);
    process.exit(1);
});