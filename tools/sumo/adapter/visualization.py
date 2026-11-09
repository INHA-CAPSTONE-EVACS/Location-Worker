"""Pure presentation rules for the live SUMO Location Worker overlay."""

from __future__ import annotations

Color = tuple[int, int, int, int]

EMERGENCY_RED: Color = (231, 76, 60, 255)
NORMAL_BLUE: Color = (52, 152, 219, 255)
NORMAL_YELLOW: Color = (241, 196, 15, 255)
DENSITY_GREEN: Color = (46, 204, 113, 170)
DENSITY_YELLOW: Color = (241, 196, 15, 200)
DENSITY_RED: Color = (231, 76, 60, 230)


def speed_color(vehicle_type: str, speed_mps: float) -> Color:
    """Return a readable vehicle color without changing simulation behaviour."""
    if vehicle_type == "emergency":
        return EMERGENCY_RED
    return NORMAL_YELLOW if speed_mps >= 13.89 else NORMAL_BLUE


def density_color(value: float) -> Color:
    """Map Location Worker density (vehicles/km/lane) to the road overlay."""
    if value <= 0:
        return DENSITY_GREEN
    if value < 20:
        return DENSITY_YELLOW
    return DENSITY_RED


def status_text(*, active: int, generation: str, simulation_time: float) -> str:
    """Format the compact top-level status shown in the SUMO GUI."""
    return (
        f"Location Worker | active: {active} | density: {generation} "
        f"| sim: {simulation_time:.1f}s"
    )
