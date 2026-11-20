.DEFAULT_GOAL := install

.PHONY: install
install:
	pnpm install
	pnpm build
	dotagents install
