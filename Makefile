.DEFAULT_GOAL := install

.PHONY: install
install:
	pnpm install
	dotagents install
