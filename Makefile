.PHONY: all backend frontend server clean run-server run-frontend-only open test benchmark install-server

all: backend

backend:
	@echo "Building C++ backend..."
	@mkdir -p backend/build
	@cd backend/build && cmake .. -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=../ > /dev/null
	@cd backend/build && make -j$$(nproc) && make install
	@mkdir -p server/bin
	@cp backend/bin/cfar_processor server/bin/ 2>/dev/null || cp backend/build/cfar_processor server/bin/
	@echo "✓ Binary installed to server/bin/cfar_processor"

test:
	@cd backend/build && ctest --output-on-failure

benchmark:
	@./server/bin/cfar_processor --benchmark

install-server:
	@cd server && pip install -r requirements.txt --break-system-packages

run-server:
	@echo "Starting Python bridge server on http://localhost:8000"
	@cd server && python main.py

run-frontend-only:
	@echo "Opening frontend (static, no backend)..."
	@cd frontend && python3 -m http.server 3000

open:
	@xdg-open http://localhost:8000 2>/dev/null || open http://localhost:8000

clean:
	@rm -rf backend/build server/bin/__pycache__ server/__pycache__
