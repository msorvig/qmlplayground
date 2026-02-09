# Patch a JS file to add ES module export if not already present
# Usage: cmake -DFILE=<file> -DSYMBOL=<symbol> -P patch_esm.cmake

file(READ "${FILE}" CONTENT)

if(NOT CONTENT MATCHES "export \\{")
    message(STATUS "Patching ${FILE} for ES modules...")
    file(APPEND "${FILE}" "\nexport { ${SYMBOL} };\n")
endif()
