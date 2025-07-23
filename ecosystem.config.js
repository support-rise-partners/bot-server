module.exports = {
  apps: [
    {
      name: "mybot",
      script: "index.js",
      merge_logs: true,
      combine_logs: true,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}
