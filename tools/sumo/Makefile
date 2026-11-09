COMPOSE := docker compose -f docker-compose.yml

.PHONY: up down logs status verify build-network gui gui-down songdo-up songdo-gui songdo-live songdo-dashboard songdo-down

up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100

status:
	$(COMPOSE) ps

verify:
	./verify.sh

build-network:
	./scenario/build-network.sh

gui:
	$(COMPOSE) --profile gui up --build --force-recreate -d sumo-gui

gui-down:
	$(COMPOSE) --profile gui stop sumo-gui

songdo-up:
	./scenario/songdo/generate.sh
	$(COMPOSE) --profile songdo up --build -d songdo-bridge

songdo-gui:
	./scenario/songdo/generate.sh
	$(COMPOSE) --profile songdo-gui up --build --force-recreate -d songdo-gui

songdo-live:
	./scenario/songdo/generate.sh
	$(COMPOSE) --profile songdo-gui stop songdo-gui
	$(COMPOSE) --profile dashboard stop songdo-dashboard-bridge songdo-dashboard
	$(COMPOSE) --profile songdo-live up --build -d songdo-live-bridge

songdo-dashboard:

	./scenario/songdo/generate.sh
	$(COMPOSE) --profile songdo-live stop songdo-live-bridge songdo-live-gui
	$(COMPOSE) --profile dashboard up --build -d songdo-dashboard-bridge songdo-dashboard

songdo-down:
	$(COMPOSE) --profile songdo --profile songdo-gui --profile songdo-live --profile dashboard stop songdo-bridge songdo-location-worker songdo-gui songdo-live-bridge songdo-live-gui songdo-dashboard-bridge songdo-dashboard
