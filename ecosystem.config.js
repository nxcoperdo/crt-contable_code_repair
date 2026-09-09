module.exports = {
  apps: [
    {
      name: 'crt-contable',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 4300,
        DATA_DIR: './data',
        ADMIN_USER: 'nico',
        ADMIN_PASS: 'CAMBIA-ESTA-CLAVE',
        SESSION_SECRET: 'CAMBIA-ESTO-POR-openssl-rand-hex-32',
      },
    },
  ],
};
