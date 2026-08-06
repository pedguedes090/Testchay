# Ai Đang Điều Khiển Tôi?

MVP party game web: **4–6 người cùng điều khiển một nhân vật**, mỗi người giữ một nhóm nút và quyền bị tráo mỗi 20 giây.

## Minigame: Chạy Trốn Xe Rác

Cả nhóm phải chạy, nhảy và ném túi rác vào xe thu gom trước khi hết 120 giây. Server giữ thẩm quyền input, quyền điều khiển, chuyển động, thời gian và kết quả.

## Chạy local

Yêu cầu Node.js 22+; không cần cài dependency ngoài.

```bash
npm test
npm start
```

Mở `http://localhost:3000`. Để test một mình, tạo phòng rồi thêm bot đến khi đủ bốn người.

## Có sẵn

- Phòng bằng mã 5 ký tự, 4–6 người.
- Client dùng được trên PC và điện thoại.
- Bot thử nghiệm cho local playtest.
- Chia quyền theo số người và tráo sau 20 giây.
- WebSocket realtime tối giản.
- Game Canvas nhẹ, giao diện cảm ứng responsive.
- Unit test bằng `node:test`.
