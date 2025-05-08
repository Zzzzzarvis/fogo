// 网络连接检测工具
const ethers = require('ethers');
const dotenv = require('dotenv');
const chalk = require('chalk');

// 加载环境变量
dotenv.config();

// ERC20 ABI - 只包含我们需要的函数
const ERC20_ABI = [
    // 查询余额
    "function balanceOf(address owner) view returns (uint256)",
    // 查询授权额度
    "function allowance(address owner, address spender) view returns (uint256)",
    // 授权
    "function approve(address spender, uint256 amount) returns (bool)",
    // 代币名称与符号
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
];

// DEX合约 ABI
const DEX_ABI = [
    // userCmd 函数
    "function userCmd(uint16 callpath, bytes calldata) payable returns (bytes)"
];

// 日志函数
function log(message, isError = false) {
    const timestamp = new Date().toISOString();
    console.log(isError ? chalk.red(`[${timestamp}] ${message}`) : chalk.green(`[${timestamp}] ${message}`));
}

async function checkRPC() {
    log("==================== RPC 连接检测 ====================");
    
    // 检查主RPC
    try {
        log(`尝试连接主RPC: ${process.env.RPC_URL}`);
        const provider = new ethers.providers.JsonRpcProvider({
            url: process.env.RPC_URL,
            timeout: 30000
        });
        const network = await provider.getNetwork();
        const blockNumber = await provider.getBlockNumber();
        log(`主RPC连接成功! 网络: ${network.name} (ChainID: ${network.chainId}), 区块高度: ${blockNumber}`);
        
        // 检查网络是否为Scroll
        if (network.chainId !== 534352) {
            log(`警告: 当前网络chainId ${network.chainId}，不是Scroll网络 (应为534352)`, true);
        } else {
            log(`确认当前网络是Scroll (chainId: 534352)`);
        }
        
        return provider;
    } catch (error) {
        log(`主RPC连接失败: ${error.message}`, true);
        
        // 尝试备用RPC
        if (process.env.BACKUP_RPC_URL) {
            log(`尝试连接备用RPC: ${process.env.BACKUP_RPC_URL}`);
            try {
                const backupProvider = new ethers.providers.JsonRpcProvider({
                    url: process.env.BACKUP_RPC_URL,
                    timeout: 30000
                });
                const network = await backupProvider.getNetwork();
                const blockNumber = await backupProvider.getBlockNumber();
                log(`备用RPC连接成功! 网络: ${network.name} (ChainID: ${network.chainId}), 区块高度: ${blockNumber}`);
                
                if (network.chainId !== 534352) {
                    log(`警告: 备用RPC网络chainId ${network.chainId}，不是Scroll网络 (应为534352)`, true);
                } else {
                    log(`确认备用RPC是Scroll网络 (chainId: 534352)`);
                }
                
                return backupProvider;
            } catch (backupError) {
                log(`备用RPC连接也失败: ${backupError.message}`, true);
                log(`请检查网络连接和RPC URL配置`, true);
                return null;
            }
        } else {
            log(`未配置备用RPC，请检查主RPC配置或添加备用RPC`, true);
            return null;
        }
    }
}

async function checkTokenContracts(provider) {
    if (!provider) return false;
    
    log("==================== 代币合约检测 ====================");
    
    try {
        // 检查USDC合约
        const usdcContract = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, provider);
        const usdcName = await usdcContract.name();
        const usdcSymbol = await usdcContract.symbol();
        const usdcDecimals = await usdcContract.decimals();
        
        log(`USDC合约连接成功:`);
        log(`- 名称: ${usdcName}`);
        log(`- 符号: ${usdcSymbol}`);
        log(`- 精度: ${usdcDecimals}`);
        
        // 检查USDT合约
        const usdtContract = new ethers.Contract(process.env.USDT_ADDRESS, ERC20_ABI, provider);
        const usdtName = await usdtContract.name();
        const usdtSymbol = await usdtContract.symbol();
        const usdtDecimals = await usdtContract.decimals();
        
        log(`USDT合约连接成功:`);
        log(`- 名称: ${usdtName}`);
        log(`- 符号: ${usdtSymbol}`);
        log(`- 精度: ${usdtDecimals}`);
        
        return true;
    } catch (error) {
        log(`代币合约检测失败: ${error.message}`, true);
        log(`请确认USDC_ADDRESS和USDT_ADDRESS设置正确，且合约可以在Scroll网络上访问`, true);
        return false;
    }
}

async function checkDex(provider) {
    if (!provider) return false;
    
    log("==================== DEX合约检测 ====================");
    
    try {
        // 检查DEX合约
        const dexAddress = process.env.CROC_SWAP_DEX;
        log(`检查DEX合约: ${dexAddress}`);
        
        // 检查合约代码
        const code = await provider.getCode(dexAddress);
        if (code === '0x' || code === '') {
            log(`错误: 指定地址没有合约代码，请检查DEX地址设置`, true);
            return false;
        }
        
        // 尝试创建合约实例
        const dexContract = new ethers.Contract(dexAddress, DEX_ABI, provider);
        log(`DEX合约连接成功`);
        
        return true;
    } catch (error) {
        log(`DEX合约检测失败: ${error.message}`, true);
        log(`请确认CROC_SWAP_DEX地址设置正确`, true);
        return false;
    }
}

async function checkWallets(provider) {
    if (!provider) return false;
    
    log("==================== 钱包检测 ====================");
    
    try {
        const privateKeys = process.env.PRIVATE_KEYS.split(',')
            .map(key => key.trim())
            .filter(key => key);
            
        if (privateKeys.length === 0) {
            log(`错误: 未找到有效的私钥，请检查PRIVATE_KEYS设置`, true);
            return false;
        }
        
        log(`找到 ${privateKeys.length} 个私钥配置`);
        let validWallets = 0;
        
        for (let i = 0; i < privateKeys.length; i++) {
            try {
                let privateKey = privateKeys[i];
                // 确保私钥格式正确
                if (privateKey.startsWith('0x')) {
                    privateKey = privateKey.substring(2);
                }
                
                const wallet = new ethers.Wallet(privateKey, provider);
                const balance = await wallet.getBalance();
                const ethBalance = ethers.utils.formatEther(balance);
                
                log(`钱包 ${i+1}: ${wallet.address}`);
                log(`- ETH余额: ${ethBalance}`);
                
                // 检查USDC余额
                const usdcContract = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, provider);
                const usdcBalance = await usdcContract.balanceOf(wallet.address);
                const usdcDecimals = await usdcContract.decimals();
                const usdcFormatted = ethers.utils.formatUnits(usdcBalance, usdcDecimals);
                log(`- USDC余额: ${usdcFormatted}`);
                
                // 检查USDT余额
                const usdtContract = new ethers.Contract(process.env.USDT_ADDRESS, ERC20_ABI, provider);
                const usdtBalance = await usdtContract.balanceOf(wallet.address);
                const usdtDecimals = await usdtContract.decimals();
                const usdtFormatted = ethers.utils.formatUnits(usdtBalance, usdtDecimals);
                log(`- USDT余额: ${usdtFormatted}`);
                
                // 检查是否有足够ETH支付gas
                if (balance.lt(ethers.utils.parseEther('0.001'))) {
                    log(`- 警告: ETH余额不足，可能无法支付gas费用`, true);
                }
                
                // 检查USDC授权
                const usdcAllowance = await usdcContract.allowance(wallet.address, process.env.CROC_SWAP_DEX);
                if (usdcAllowance.gt(0)) {
                    log(`- USDC已授权DEX合约`);
                } else {
                    log(`- USDC未授权DEX合约，将在交易时自动授权`);
                }
                
                // 检查USDT授权
                const usdtAllowance = await usdtContract.allowance(wallet.address, process.env.CROC_SWAP_DEX);
                if (usdtAllowance.gt(0)) {
                    log(`- USDT已授权DEX合约`);
                } else {
                    log(`- USDT未授权DEX合约，将在交易时自动授权`);
                }
                
                validWallets++;
            } catch (walletError) {
                log(`钱包 ${i+1} 检测失败: ${walletError.message}`, true);
            }
        }
        
        if (validWallets === 0) {
            log(`错误: 所有钱包检测失败，请检查私钥配置`, true);
            return false;
        }
        
        log(`检测到 ${validWallets}/${privateKeys.length} 个有效钱包`);
        return true;
    } catch (error) {
        log(`钱包检测失败: ${error.message}`, true);
        return false;
    }
}

async function checkEnvConfig() {
    log("==================== 环境配置检测 ====================");
    
    // 检查必要配置
    const requiredVars = [
        'RPC_URL', 
        'PRIVATE_KEYS', 
        'CROC_SWAP_DEX', 
        'USDC_ADDRESS', 
        'USDT_ADDRESS',
        'TARGET_TOTAL_VOLUME_MIN',
        'TARGET_TOTAL_VOLUME_MAX',
        'SINGLE_SWAP_AMOUNT_MIN',
        'SINGLE_SWAP_AMOUNT_MAX',
        'TIME_INTERVAL_MIN',
        'TIME_INTERVAL_MAX',
        'RESERVE_ETH_MIN',
        'RESERVE_ETH_MAX'
    ];
    
    let allConfigured = true;
    for (const v of requiredVars) {
        if (!process.env[v]) {
            log(`错误: 缺少必要配置项 ${v}`, true);
            allConfigured = false;
        }
    }
    
    if (!allConfigured) {
        log(`请检查.env文件，确保所有必要配置项都已设置`, true);
        return false;
    }
    
    // 检查数值配置
    try {
        // 检查交易量设置
        const minVolume = parseFloat(process.env.TARGET_TOTAL_VOLUME_MIN);
        const maxVolume = parseFloat(process.env.TARGET_TOTAL_VOLUME_MAX);
        if (isNaN(minVolume) || isNaN(maxVolume) || minVolume <= 0 || maxVolume <= 0) {
            log(`错误: 交易量设置无效，必须为正数`, true);
            allConfigured = false;
        } else if (minVolume > maxVolume) {
            log(`错误: 最小交易量大于最大交易量`, true);
            allConfigured = false;
        } else {
            log(`交易量范围设置: $${minVolume} - $${maxVolume}`);
        }
        
        // 检查单次交易金额
        const minAmount = parseFloat(process.env.SINGLE_SWAP_AMOUNT_MIN);
        const maxAmount = parseFloat(process.env.SINGLE_SWAP_AMOUNT_MAX);
        if (isNaN(minAmount) || isNaN(maxAmount) || minAmount <= 0 || maxAmount <= 0) {
            log(`错误: 单次交易金额设置无效，必须为正数`, true);
            allConfigured = false;
        } else if (minAmount > maxAmount) {
            log(`错误: 最小单次交易金额大于最大单次交易金额`, true);
            allConfigured = false;
        } else {
            log(`单次交易金额范围: $${minAmount} - $${maxAmount}`);
        }
        
        // 检查时间间隔
        const minInterval = parseFloat(process.env.TIME_INTERVAL_MIN);
        const maxInterval = parseFloat(process.env.TIME_INTERVAL_MAX);
        if (isNaN(minInterval) || isNaN(maxInterval) || minInterval <= 0 || maxInterval <= 0) {
            log(`错误: 时间间隔设置无效，必须为正数`, true);
            allConfigured = false;
        } else if (minInterval > maxInterval) {
            log(`错误: 最小时间间隔大于最大时间间隔`, true);
            allConfigured = false;
        } else {
            log(`交易时间间隔: ${minInterval} - ${maxInterval} 秒`);
        }
        
        // 检查ETH保留量
        const minEthReserve = parseFloat(process.env.RESERVE_ETH_MIN);
        const maxEthReserve = parseFloat(process.env.RESERVE_ETH_MAX);
        if (isNaN(minEthReserve) || isNaN(maxEthReserve) || minEthReserve <= 0 || maxEthReserve <= 0) {
            log(`错误: ETH保留量设置无效，必须为正数`, true);
            allConfigured = false;
        } else if (minEthReserve > maxEthReserve) {
            log(`错误: 最小ETH保留量大于最大ETH保留量`, true);
            allConfigured = false;
        } else {
            log(`ETH保留量范围: ${minEthReserve} - ${maxEthReserve} ETH`);
        }
    } catch (error) {
        log(`配置参数检测失败: ${error.message}`, true);
        return false;
    }
    
    if (allConfigured) {
        log(`所有配置检测通过`);
    }
    
    return allConfigured;
}

async function runTests() {
    log("开始执行系统检测...");
    
    // 检查环境配置
    const configOk = await checkEnvConfig();
    if (!configOk) {
        log("环境配置检测失败，请修复上述错误后重试", true);
        return;
    }
    
    // 检查RPC连接
    const provider = await checkRPC();
    if (!provider) {
        log("RPC连接检测失败，请修复上述错误后重试", true);
        return;
    }
    
    // 检查代币合约
    const tokensOk = await checkTokenContracts(provider);
    if (!tokensOk) {
        log("代币合约检测失败，请修复上述错误后重试", true);
        return;
    }
    
    // 检查DEX合约
    const dexOk = await checkDex(provider);
    if (!dexOk) {
        log("DEX合约检测失败，请修复上述错误后重试", true);
        return;
    }
    
    // 检查钱包
    const walletsOk = await checkWallets(provider);
    if (!walletsOk) {
        log("钱包检测失败，请修复上述错误后重试", true);
        return;
    }
    
    log("所有检测通过，系统已准备就绪! 您可以运行主程序进行交易。");
}

// 运行测试
runTests().catch(error => {
    log(`检测过程出错: ${error.stack || error.message}`, true);
}); 