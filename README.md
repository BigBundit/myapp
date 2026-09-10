# BNH WordPress MCP Server

Read-only MCP server สำหรับเชื่อม ChatGPT กับ WordPress/WooCommerce ผ่าน REST API

## Tools
- search_pages
- get_page
- find_url_usage
- get_products
- check_site_status

## Deploy บน Render
โปรเจกต์มี `render.yaml` พร้อม deploy โดยใช้ค่าเริ่มต้น:
- Service: `bnh-wordpress-mcp`
- Region: Singapore
- Plan: Free
- `WP_BASE_URL=https://www.bnhhospital.com`

Health endpoint: `/health`
MCP endpoint: `/mcp`

เริ่มต้นแบบ public/read-only ก่อน โดยยังไม่ใส่ WordPress หรือ WooCommerce credentials ลงใน Git
