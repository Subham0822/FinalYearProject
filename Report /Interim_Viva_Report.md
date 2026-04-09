# Project Report

## Project Title
**AI-Based Electric Vehicle Routing Problem Based on Distance, Time of the Day, Availability of Charging Station Locations, and Dynamic Charging Prices**

## 1. Problem Identification
- Electric vehicles are becoming important in modern transportation because they support cleaner and more sustainable mobility.
- EV adoption is still affected by practical problems such as limited battery range, charging time, and uneven charging infrastructure.
- A major issue is **range anxiety**, where drivers fear that the battery may not be enough to reach the destination or the next charging station.
- This becomes more serious during long-distance travel, highway trips, late-night travel, or in areas with limited charging stations.
- A route that looks short in a normal navigation app may still be unsuitable for an EV if the charging station on that route is occupied, incompatible, expensive, or too far away.
- Traditional navigation systems mainly optimize distance and travel time, while EV routing must also consider battery level, charging stop feasibility, waiting time, connector compatibility, and charging cost.
- The problem becomes more complex due to dynamic factors such as traffic conditions, time-of-day effects, changing charging prices, and varying station availability.
- This project addresses the problem by developing an AI-assisted EV routing system that recommends feasible and optimized routes using distance, departure time, charging station location, predicted availability, and dynamic charging price.
- The problem is important for smart cities and sustainable transport because better EV routing can improve travel reliability, reduce energy waste, and strengthen intelligent transportation systems.
- This work contributes toward intelligent transportation systems by integrating real-time decision-making, predictive analytics, and multi-objective optimization for electric vehicle routing.

## 2. Study of Existing Works and Feasibility
These approaches are widely studied in the Electric Vehicle Routing Problem (EVRP) literature to address battery constraints and charging dependencies.
These approaches have been widely explored in prior research and practical systems [1][2][3].

Existing EV routing research mainly uses four approaches:

1. **Classical optimization methods** such as Mixed Integer Linear Programming and dynamic programming are used to model EV routing as a constrained optimization problem with battery, charging, and distance limits. Their main advantage is that they provide logically consistent and mathematically strong solutions. They are also useful for benchmark studies and small-scale controlled environments. However, they become computationally expensive when the network becomes large, and they usually assume static inputs such as fixed traffic and fixed charging conditions. This limits their applicability in real-time routing.
2. **Metaheuristic methods** such as Genetic Algorithm, Ant Colony Optimization, and Particle Swarm Optimization are used to search large routing spaces and generate near-optimal solutions in complex scenarios. They are flexible, support multi-objective optimization, and are useful when exact methods become too slow. They can also adapt to different cost functions such as time, energy, and charging cost. Their limitations are that solution quality depends on parameter tuning, convergence may vary, and the output may not always be stable or easily explainable.
3. **Machine learning methods** are used in EV routing mainly for prediction tasks such as traffic estimation, station occupancy forecasting, energy consumption modeling, and demand forecasting. Their strength lies in learning hidden patterns from historical or live data and improving decision quality under uncertainty. They are suitable for time-dependent conditions and help move EV routing beyond static planning. Their limitations include dependency on data quality, possible prediction errors in unseen conditions, and the challenge of directly converting predictions into an optimal route decision.
4. **Hybrid methods** combine forecasting with optimization or rule-based route scoring. These are the most practical for EV routing because real-world decisions require both prediction and route selection. Hybrid approaches can jointly consider battery feasibility, future charging conditions, and user preferences. They also support more realistic decision-making under changing conditions. Their main limitation is system complexity, since integrating multiple components increases implementation and maintenance effort.

In real systems, smart navigation platforms are beginning to include EV-oriented features. For example, modern map services and EV navigation concepts can estimate battery-aware routes and suggest charging stops. However, many existing real-world systems still focus mainly on reachability and travel time. They often provide limited support for dynamic charging prices, weak prediction of charger availability, and poor transparency about why one route is preferred over another. This creates a gap between route suggestion and practical charging-aware decision-making.

From this study, a hybrid AI model is the most feasible choice for the proposed work. The current system already demonstrates this feasibility through a working prototype that includes a frontend interface, backend microservices, forecasting logic, route generation, and automated testing. The architecture is also scalable because data, forecasting, and routing are separated into services, making future improvements easier. This allows the project to grow toward live data integration, larger station coverage, better prediction models, and stronger deployment readiness.

## 3. Objectives and Methodology
The main objectives of the project are:

1. To develop an AI-based EV routing system that generates feasible and optimized intercity routes under battery and charging constraints.
2. To implement multi-factor decision-making using distance, departure time, charging station availability, and dynamic charging price as routing inputs.
3. To generate feasible direct and charging-assisted route options that minimize charging risk, reduce travel cost, and improve route reliability under dynamic conditions.
4. To provide explainable multi-objective recommendations through balanced, fastest, and cheapest optimization modes.
5. To build and validate a working prototype with integrated frontend, backend services, and route evaluation logic.

The methodology followed is:

1. **Input collection:** the system collects origin, destination, departure time, battery state of charge, reserve battery level, vehicle efficiency, charging power, and connector type.
2. **Data processing:** charging-station data is filtered using location, connector compatibility, station characteristics, and route reachability constraints.
3. **Forecasting:** the system estimates station availability, waiting time, and dynamic charging price at the predicted arrival time using time-dependent demand behavior.
4. **Route generation:** feasible direct, one-stop, and two-stop routes are generated after checking battery constraints and charging-stop reachability.
5. **Optimization and ranking:** candidate routes are ranked using multi-factor optimization based on distance, travel time, charging cost, detour, and predicted availability.
6. **Output visualization:** the best route and alternatives are shown through a web interface with map-based presentation and explainable output.

The system has been developed using a **Next.js frontend**, **Python FastAPI microservices**, a seeded charging-station dataset with optional live integration, and infrastructure support for **Redis** and **PostgreSQL/PostGIS**.

## 4. Working Model
The current working model developed for this project includes:

1. A working prototype named **VoltPath AI** with a frontend interface for EV trip planning and route comparison.
2. A route recommendation engine that supports direct, one-stop, and two-stop routes.
3. Forecasting logic for charging station availability, waiting time, and dynamic charging price.
4. Recommendation modes for **balanced**, **fastest**, and **cheapest** route selection.
5. Charging connector compatibility filtering and map-based route visualization.
6. A backend organized into API gateway, data service, forecasting service, and routing service.
7. Docker-based infrastructure, starter database schema, and automated tests for route feasibility and time-dependent behavior.

The model can identify whether a direct route is feasible, insert charging stops when required, and produce different recommendations for different departure times and optimization preferences. The current test suite passes successfully with **6 out of 6 tests**.

**Figures (Working Prototype):**
[Add screenshot of home page / trip input form here]
[Add screenshot of route recommendation output here]
[Add screenshot of map visualization / charging stops here]

## 5. Current Results and Future Work
The current prototype demonstrates that EV routing becomes more practical when charging availability and dynamic price are included in route selection. The system already provides useful decision support for EV travel and shows the feasibility of the proposed approach.

The next phase of the project will focus on integrating richer real-time data, improving prediction accuracy, expanding geographic coverage, and evaluating performance using more detailed metrics such as travel-time reduction, charging-cost savings, and recommendation quality.

## 6. Conclusion
This project addresses the Electric Vehicle Routing Problem using an AI-based approach that combines route feasibility, charging station availability, time-of-day effects, and dynamic charging prices. The work completed so far has resulted in a functional prototype with clear deliverables and a strong base for further development in the final phase.

## References
[1] Next.js, “Next.js Documentation.” [Online]. Available: https://nextjs.org/docs

[2] React, “React Documentation.” [Online]. Available: https://react.dev/

[3] FastAPI, “FastAPI Documentation.” [Online]. Available: https://fastapi.tiangolo.com/

[4] Open Charge Map, “Open Charge Map.” [Online]. Available: https://openchargemap.org/

[5] Project OSRM, “Open Source Routing Machine API Documentation.” [Online]. Available: https://project-osrm.org/docs/v5.24.0/api/

[6] Redis, “Redis Documentation.” [Online]. Available: https://redis.io/docs/latest/

[7] PostgreSQL Global Development Group, “PostgreSQL Documentation.” [Online]. Available: https://www.postgresql.org/docs/

[8] PostGIS Project Steering Committee, “PostGIS Documentation.” [Online]. Available: https://postgis.net/documentation/

[9] Leaflet, “Leaflet Documentation.” [Online]. Available: https://leafletjs.com/

[10] React Leaflet, “React Leaflet Documentation.” [Online]. Available: https://react-leaflet.js.org/

[11] WiseLibs, “better-sqlite3.” [Online]. Available: https://github.com/WiseLibs/better-sqlite3
