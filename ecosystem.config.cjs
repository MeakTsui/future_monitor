module.exports = {
  apps: [
    // 市场状态计算已集成到 ws-rule3 进程中，每秒计算，每分钟保存
    // {
    //   name: 'market-state',
    //   script: 'market_state_cron.js',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   autorestart: true,
    //   watch: false,
    //   env: {
    //     LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    //   }
    // },
    {
      name: 'ws-rule3',
      script: 'ws_rule3_monitor.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    },
    {
      name: 'server',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
        PORT: process.env.PORT || 8080
      }
    },
    {
      name: 'symbols-update',
      script: 'symbols_update.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      cron_restart: '0 0,12 * * *',
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    },
    {
      name: 'avgvol-hourly',
      script: 'avg_vol_hourly.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      cron_restart: '0 * * * *',
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    },
    {
      name: 'supply-sync-binance',
      script: 'supply_sync_binance.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      cron_restart: '0 0,3 * * *',
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    },
    {
      name: 'volume-score-calc',
      script: 'volume_score_calculator.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    },
    {
      name: 'market-metrics-sender',
      script: 'market_metrics_sender.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
      }
    }
  ]
};
