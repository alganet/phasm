phasm: $(SAPI_PHASM_PATH)

$(SAPI_PHASM_PATH): $(PHP_GLOBAL_OBJS) $(PHP_BINARY_OBJS) $(PHP_PHASM_OBJS)
	$(BUILD_PHASM)

# PHP_SELECT_SAPI adds install-phasm to the install targets. There is nothing to
# install — the artifact is a wasm module the build script copies into dist/.
install-phasm:
	@echo "phasm SAPI: nothing to install (see scripts/build.sh)"
