PYTHON ?= python

.PHONY: test lint typecheck format golden fixture

test:
	$(PYTHON) tasks.py test

lint:
	$(PYTHON) tasks.py lint

typecheck:
	$(PYTHON) tasks.py typecheck

format:
	$(PYTHON) tasks.py format

golden:
	$(PYTHON) tasks.py golden

fixture:
	$(PYTHON) tasks.py fixture
