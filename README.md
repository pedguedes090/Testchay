# Ai Đang Điều Khiển Tôi?

MVP party game multiplayer chạy trực tiếp trên trình duyệt. **4–6 người cùng điều khiển một nhân vật**, mỗi người giữ một nhóm nút khác nhau và quyền bị tráo trong lúc chơi.

## Minigame: Chạy Trốn Xe Rác

Cả nhóm đuổi theo xe rác, né chướng ngại và ném túi vào xe trước khi hết giờ. Server quyết định quyền điều khiển, input hợp lệ, chuyển động, va chạm, độ bền túi, thời gian và kết quả.

## Tính năng hiện có

- Tạo hoặc vào phòng bằng mã 5 ký tự.
- 4–6 người; có bot để playtest một mình.
- Các nhóm quyền: di chuyển, tăng tốc/phanh, nhảy, trượt, camera và ném.
- Tráo quyền định kỳ mà không dựng lại toàn bộ DOM ở mỗi state update.
- Điều khiển bàn phím, chuột và cảm ứng; tự giải phóng nút khi mất focus hoặc mất mạng.
- Reconnect bằng session riêng trong WebSocket body; token không nằm trong URL.
- Chủ phòng được chuyển tự động khi host rời phòng.
- Chỉ host mới có thể bắt đầu và chơi lại; rematch chỉ hợp lệ sau khi trận kết thúc.
- Canvas responsive cho desktop và điện thoại ngang.
- Server Node.js không cần dependency ngoài.

## Chạy local

Yêu cầu Node.js 22+.

```bash
npm test
npm run check
npm start
```

Mở `http://localhost:3000`. Để test một mình, tạo phòng rồi thêm ba bot.

## Kiểm thử trình duyệt và ảnh chụp

Harness browser dùng Chromium DevTools Protocol, kết nối WebSocket thật và kiểm tra toàn bộ luồng: tạo phòng → lobby → countdown → gameplay → ngắt mạng/reconnect → mobile landscape → kết quả.

```bash
# Khởi động một server test ngắn ở cổng 4173
COUNTDOWN_MS=1000 GAME_DURATION_MS=9000 SHUFFLE_MS=3000 PORT=4173 npm start

# Terminal khác
npm run test:browser
```

Báo cáo và browser report được commit trong [`docs/test-evidence`](docs/test-evidence/TEST-REPORT.md); ảnh PNG gốc nằm trong gói evidence bàn giao.

## Kiến trúc

- `server.js`: HTTP static server, WebSocket framing, room/session, authoritative simulation.
- `public/app.js`: SPA, reconnect, input và Canvas renderer.
- `public/client-core.js`: logic client thuần để unit test.
- `test/server.test.js`: unit + WebSocket integration tests.
- `test/client.test.js`: regression tests cho storage, input và render key.
- `test/e2e_screenshots.py`: browser E2E và screenshot assertions.

## Giới hạn MVP

Room hiện lưu trong memory và phù hợp một Node process. Chưa có database, horizontal scaling, matchmaking công khai, voice chat hoặc hệ thống tài khoản.
