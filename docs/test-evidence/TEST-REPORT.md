# Báo cáo kiểm thử MVP — Ai Đang Điều Khiển Tôi?

**Ngày chạy:** 2026-08-06  
**Nhánh:** `feat/control-chaos-hardening`  
**Kịch bản browser:** phòng `33VPD`, kết quả **Giao được rồi!**, **1723 điểm**.

## Kết luận

- **19/19** unit và integration test đạt.
- Syntax check đạt cho `server.js`, `public/app.js`, `public/client-core.js`.
- HTTP smoke test trả `200` cho HTML và hai module JavaScript; `/health` trả trạng thái khỏe.
- Browser E2E đi hết luồng tạo phòng → 4 người → countdown → gameplay → ngắt WebSocket → tự reconnect → mobile landscape → kết quả.
- **0 JavaScript exception** trong toàn bộ browser flow.
- Màn kết quả vừa khung mobile landscape và desktop không còn scrollbar thừa.

## Tổng quan ảnh

Tám ảnh PNG gốc được đính kèm trong gói evidence bàn giao của phiên kiểm thử. Báo cáo JSON và log kiểm thử được commit cùng code.

## Checkpoint browser

### 1. Trang chủ desktop

Kiểm tra form tạo/vào phòng, typography, trạng thái online và bố cục 1440px.

Ảnh gốc: `01-home-desktop.png` (có trong gói evidence đầy đủ).

### 2. Lobby đủ bốn người

Tạo phòng thật qua WebSocket, thêm ba bot, kiểm tra mã phòng, danh sách người chơi, quyền host và nút bắt đầu.

Ảnh gốc: `02-lobby-four-players.png` (có trong gói evidence đầy đủ).

### 3. Countdown

Host bắt đầu trận; client chuyển sang Canvas/HUD và khóa đúng phase countdown.

Ảnh gốc: `03-countdown-desktop.png` (có trong gói evidence đầy đủ).

### 4. Gameplay desktop

Kiểm tra timer, độ bền túi, va chạm, quyền hiện tại, thời gian tráo quyền, obstacle, xe rác và nút điều khiển.

Ảnh gốc: `04-gameplay-desktop.png` (có trong gói evidence đầy đủ).

### 5. Reconnect giữa trận

Harness đóng **socket thật**. Client giải phóng input, xóa trạng thái nút đang giữ, nối lại bằng session và tiếp tục đúng trận cũ.

Ảnh gốc: `05-gameplay-after-reconnect.png` (có trong gói evidence đầy đủ).

### 6. Mobile landscape

Viewport `844×390`; HUD, Canvas và touch controls đều nằm trong khung, không tràn ngang.

Ảnh gốc: `06-gameplay-mobile-landscape.png` (có trong gói evidence đầy đủ).

### 7. Kết quả mobile

Assertion tự động xác nhận card và nút chơi lại nằm hoàn toàn trong viewport landscape.

Ảnh gốc: `07-result-mobile.png` (có trong gói evidence đầy đủ).

### 8. Kết quả desktop

Assertion tự động xác nhận không có vertical scrollbar thừa.

Ảnh gốc: `08-result-desktop.png` (có trong gói evidence đầy đủ).

## Phạm vi test tự động

### Client

- Safe storage khi `localStorage` bị chặn hoặc getter ném `SecurityError`.
- Không gửi lặp input đang giữ; giải phóng toàn bộ theo sequence.
- Render key ổn định khi chỉ state động thay đổi.
- Reconnect credentials chỉ nằm trong WebSocket body.
- `setPointerCapture()` lỗi không làm mất input.
- Xóa trạng thái `.active` sau disconnect.

### Server và gameplay

- Validate tên và room code.
- Phân quyền duy nhất cho 4, 5 và 6 người.
- Chặn action không thuộc role.
- Reconnect giữ nguyên session/player.
- Disconnect giải phóng input.
- Rematch chỉ dành cho host sau khi kết thúc.
- State xuất obstacle và bag integrity.
- Va chạm làm giảm độ bền; trượt đúng lúc né được vật cản.
- Host migration khi chủ phòng mất kết nối.
- Public state không lộ reconnect token.

## Review issues đã xử lý

- Bỏ token khỏi query string; auth diễn ra trong WebSocket message.
- Chặn khách hoặc client đang PLAYING gọi rematch.
- Không dựng lại toàn bộ DOM mỗi 100–120ms; chỉ dựng lại khi phase/role đổi.
- Tách toast timer khỏi reconnect/render timer.
- Giải phóng input và visual active state khi socket đóng, blur, pagehide hoặc tab ẩn.
- WebSocket parser hỗ trợ frame lớn, nhiều frame trong cùng TCP chunk và close handshake.

## Môi trường browser test

Chromium trong sandbox bị policy chặn navigation đến localhost. Harness dùng `Page.setDocumentContent` để nạp **đúng HTML/CSS/JS của repo**, nhưng vẫn kết nối đến **server WebSocket thật** ở `127.0.0.1:4173`. Vì vậy routing static được kiểm tra riêng bằng HTTP smoke test, còn UI/realtime được kiểm tra qua browser thật.

## Bằng chứng dạng text

- [`browser-report.json`](browser-report.json)
- Kết quả `npm test` và `npm run check` được chạy lại trước khi tạo commit; GitHub Actions chạy lại hai lệnh này trên PR.

## Giới hạn còn lại của MVP

Room và session hiện lưu trong memory của một Node process. Việc triển khai nhiều instance cần shared state/pub-sub; matchmaking công khai, tài khoản và voice chat chưa thuộc phạm vi MVP này.
